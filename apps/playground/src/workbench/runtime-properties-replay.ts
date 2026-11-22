import type {GameScreenshot} from '@godot-js/engine/browser/dedicated/worker-runner';
import type {PlaygroundApi} from '../playground-api';
import type {DebugExit} from '../debug-api';
import {RUNTIME_PROPERTIES_PLAYER_PATH} from '../runtime-properties-demo.ts';

type Identity = GameScreenshot['run'];
type Target = {runId: string; path: string; expectedInstanceId: string};
type Frame = {caption: string; png: Blob; metadata: Omit<GameScreenshot, 'bytes'>};
type Value = {type: 'int' | 'float' | 'bool' | 'string' | 'vector2'; value: unknown};
type OwnedRun = {run: Identity; releaseId: string; target: Target; attemptId: string; sourceHash: string};
export interface RuntimePropertiesReplayActions {
  open(): Promise<string>;
  cancelLaunch(attemptId: string): void;
  status(message: string): void;
  report(message: string): void;
  frame(frame: Frame): void;
}

const identityFields = ['runId', 'revision', 'buildKey', 'generation', 'documentId', 'workerId', 'runConfigurationHash'] as const;
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function assertReplayIdentity(actual: Identity, expected: Identity) {
  assert(actual && identityFields.every(field => actual[field] === expected[field]), '观察结果不属于捕获的运行身份');
}
export function hasCleanRuntimeExit(exit: DebugExit | undefined) {
  return exit?.evidence === 'host-report' && exit.report.reason === 'clean-exit' &&
    exit.report.sessionFacts?.nativeExit?.code === 0 && exit.report.sessionFacts?.hostCleanup === 'complete';
}
function unbox<T>(reply: unknown): T {
  const value = reply as {ok?: boolean; result?: T; error?: {message?: string}};
  assert(value?.ok === true, value?.error?.message ?? 'API 操作失败');
  return value.result as T;
}
function facadeData<T>(reply: unknown): T { return unbox<{data: T}>(reply).data; }
function deadline(message: string) {
  const end = performance.now() + 5000;
  return () => {const remaining = Math.ceil(end - performance.now()); assert(remaining > 0, message); return remaining;};
}

/** Reads the complete health-bar interval, rather than inferring width from two pixels. */
export async function inspectRuntimePropertiesPng(png: Blob, frame: Pick<GameScreenshot, 'width' | 'height'>) {
  const image = await createImageBitmap(png);
  try {
    assert(image.width === frame.width && image.height === frame.height, 'PNG 尺寸与回执不符');
    const canvas = document.createElement('canvas');canvas.width = image.width;canvas.height = image.height;
    const context = canvas.getContext('2d')!;context.drawImage(image, 0, 0);
    const y = Math.floor(32 * frame.height / 640), row = context.getImageData(0, y, frame.width, 1).data;
    const green: number[] = [];
    for (let x = 0; x < frame.width; x++) if (row[x*4] === 0 && row[x*4+1] === 255 && row[x*4+2] === 0 && row[x*4+3] === 255) green.push(x);
    const marker = (x: number) => Array.from(context.getImageData(Math.floor(x*frame.width/960), Math.floor(256*frame.height/640), 1, 1).data);
    return {greenStart: green[0], greenEnd: green.length ? green.at(-1)! + 1 : undefined,
      greenLength: green.length, contiguous: green.every((x, index) => x === green[0] + index),
      markers: [64,128,192].map(marker)};
  } finally { image.close(); }
}

export async function runRuntimePropertiesReplay(api: PlaygroundApi, actions: RuntimePropertiesReplayActions, signal: AbortSignal) {
  const demoId = await actions.open();signal.throwIfAborted();
  const context = api.get_project_context().result;
  assert(context.projectId === demoId && context.editorRevision !== null, '属性验证项目已切换');
  const input = {projectId: demoId, expectedEditorRevision: context.editorRevision};
  const checked = unbox<any>(await api.check(input));
  assert(checked.status === 'completed' && checked.diagnostics.counts.error === 0, '属性示例类型检查未通过');
  const evidence: Record<string, unknown> = {projectId: demoId, editorRevision: context.editorRevision, checks: [], frames: []};
  const checks = evidence.checks as unknown[];
  const recordedFrames = evidence.frames as unknown[];
  function bound(owned: OwnedRun) {
    const current = api.get_project_context().result;
    assert(current.projectId === demoId && current.editorRevision === input.expectedEditorRevision &&
      current.activeRunId === owned.run.runId && current.latestBuildAttemptId === owned.attemptId, '验证期间项目或运行意图已变化');
  }
  function correlation(reply: any, owned: OwnedRun) {
    assertReplayIdentity(reply.receipt?.run, owned.run);
    assert(reply.receipt.releaseId === owned.releaseId && reply.receipt.path === owned.target.path &&
      reply.receipt.expectedInstanceId === owned.target.expectedInstanceId, '属性回执的发布或节点身份不符');
    assert(Number.isSafeInteger(reply.receipt.accessSequence) && reply.receipt.accessSequence > 0 &&
      reply.receipt.requestId === owned.run.runId + ':' + reply.receipt.accessSequence, '属性请求序号不符');
  }
  async function read(owned: OwnedRun, names: Array<{name: string; expectedType: Value['type']}>) {
    const reply = await api.read_runtime_properties({...owned.target, properties: names}, signal);
    const data = unbox<any>(reply);correlation(reply, owned);
    assert(data.outcome === 'completed' && data.properties.length === names.length, '属性读取没有完整结算');
    const values: Record<string, unknown> = {};
    data.properties.forEach((item: any, index: number) => {
      assert(item.name === names[index].name && item.status === 'value' && item.readEntered === true &&
        item.value.type === names[index].expectedType, '属性实际读取结果不可用');
      values[item.name] = item.value.value;
    });checks.push({kind: 'read', reply});return values;
  }
  const all = [{name:'health',expectedType:'int'}, {name:'move_step',expectedType:'float'},
    {name:'can_move',expectedType:'bool'}, {name:'display_name',expectedType:'string'}, {name:'position',expectedType:'vector2'}] as const;
  async function values(owned: OwnedRun) {return read(owned, [...all]);}
  async function write(owned: OwnedRun, property: string, type: 'int'|'float', before: number, value: number) {
    bound(owned);
    const response = await api.summer_call({op:'engine.runtime_set',input:{path:owned.target.path,property,value}}, signal);
    const data = facadeData<any>(response);
    assert(data.route === 'runtime_properties', '属性写入未使用新原生能力');
    const result = unbox<any>(data.payload);correlation(data.payload, owned);
    assert(result.outcome === 'applied' && result.phase === 'readback' && result.writeEntered === true &&
      equal(result.beforeValue,{type,value:before}) && equal(result.comparisonValue,{type,value}) &&
      equal(result.observedValue,{type,value}) && ['process','physics','drawn'].every(key => /^\d+$/.test(result.frame?.[key])),
    '属性写入的原生 before/after/frame 未得到确认');
    checks.push({kind:'summer-write',response});actions.report(`${property} · ${before} → ${value} · ${data.payload.receipt.requestId} · applied`);
    return result;
  }
  async function tap(owned: OwnedRun, code: 'ArrowRight'|'ArrowDown') {
    signal.throwIfAborted();bound(owned);
    const input = unbox<{operationId:string}>(api.game_input({runId:owned.run.runId,gesture:{kind:'key_tap',code}}));
    const receipt = unbox<any>(await api.wait_for_input({runId:owned.run.runId,operationId:input.operationId},signal));
    assertReplayIdentity(receipt.operation.run, owned.run);
    assert(receipt.operation.status === 'dispatched' && receipt.operation.down === 'dispatched' && receipt.operation.up === 'dispatched', '输入按下与释放未全部确认');
    checks.push({kind:'input',code,receipt});
  }
  async function capture(owned: OwnedRun, health: number, x: number, caption: string, afterSerial = 0) {
    const remaining = deadline('未观察到属性改变后的实际画面');
    for (;;) {
      signal.throwIfAborted();bound(owned);remaining();
      const data = facadeData<GameScreenshot>(await api.summer_call({op:'engine.screenshot',input:{target:'game'}},signal));
      assertReplayIdentity(data.run,owned.run);assert(data.releaseId === owned.releaseId,'PNG 发布身份不符');
      const png = new Blob([data.bytes],{type:data.mimeType});
      const pixels = await inspectRuntimePropertiesPng(png,data);
      const expectedStart=24*data.width/960,expectedEnd=(24+health*2)*data.width/960;
      const white=[255,255,255,255],red=[255,0,0,255];
      const markerOk=pixels.markers.every((color,index)=>equal(color,[64,128,192][index]===x?white:red));
      if(data.renderSerial>afterSerial&&pixels.contiguous&&Math.abs((pixels.greenStart??-100)-expectedStart)<=1&&
        Math.abs((pixels.greenEnd??-100)-expectedEnd)<=1&&markerOk){
        const {bytes,...metadata}=data;const sample={caption,png,metadata};
        recordedFrames.push({caption,metadata,pixels,byteLength:bytes.byteLength});actions.frame(sample);return data.renderSerial;
      }
    }
  }
  async function withRun(visit:(owned:OwnedRun)=>Promise<void>) {
    let attemptId:string|undefined,owned:OwnedRun|undefined,exit:DebugExit|undefined;
    try {
      signal.throwIfAborted();
      const response=await api.summer_call({op:'engine.play',input:{}},signal);
      const accepted=facadeData<{attemptId:string;run:null}>(response);
      assert(typeof accepted.attemptId==='string'&&accepted.run===null,'启动回执缺少独立 attempt 身份');
      attemptId=accepted.attemptId;
      const ready=unbox<any>(await api.wait_for_event({attemptId,until:'running',timeoutMs:60_000},signal));
      assert(ready.outcome==='reached'&&ready.run,'属性示例未进入运行状态');
      const run=unbox<any>(api.get_run({runId:ready.run.runId}));
      assert(run.runtimeProperties.supported===true&&run.runtimeProperties.ready===true,'运行时公开属性能力未就绪');
      const build=unbox<any>(api.get_build({attemptId}));
      assert(build.editorRevision===input.expectedEditorRevision&&/^[a-f0-9]{64}$/.test(build.sourceHash),'构建源码身份不匹配');
      bound({run,attemptId} as OwnedRun);
      const tree=facadeData<any>(await api.summer_call({op:'engine.get_runtime_tree',input:{depth:3,limit:500}},signal));
      assertReplayIdentity(tree.run,run);assert(tree.releaseId===run.release.releaseId,'运行树发布身份不符');
      const targets=tree.nodes.filter((node:any)=>node.path===RUNTIME_PROPERTIES_PLAYER_PATH&&node.type==='Node2D');
      assert(targets.length===1,'示例中没有唯一 Main/Player 节点');
      owned={run,releaseId:run.release.releaseId,target:{runId:run.runId,path:targets[0].path,expectedInstanceId:targets[0].instanceId},attemptId,sourceHash:build.sourceHash};
      await visit(owned);
    } finally {
      if(attemptId&&!owned)actions.cancelLaunch(attemptId);
      const build=attemptId?api.get_build({attemptId}):undefined;
      const target=owned?.run.runId??(build?.ok&&build.result.preview?.status==='session-created'?build.result.preview.runId:undefined);
      if(target){
        const current=api.get_project_context().result;
        if(current.activeRunId===target&&current.latestBuildAttemptId===attemptId)
          await api.summer_call({op:'engine.stop',input:{}});
        else api.stop({runId:target});
        const ended=await api.wait_for_event({runId:target,until:'exited',timeoutMs:10000});
        exit=ended.ok?ended.result.run?.exit:undefined;
        actions.report(`运行 ${target} · ${exit?.evidence??'unconfirmed'} · ${exit?.report.reason??'exit unknown'}`);
      }
    }
    assert(owned&&hasCleanRuntimeExit(exit),'本次运行缺少原生零退出与完整清理回执');
    return {owned,exit};
  }

  actions.status('正在发现标准导出属性');
  const first=await withRun(async owned=>{
    const described=await api.describe_runtime_properties({...owned.target,names:['health','move_step','can_move','display_name','internalCounter']},signal);
    const description=unbox<any>(described);correlation(described,owned);
    assert(description.mode==='names'&&!description.scan.truncated,'导出元数据发现不完整');
    for(const item of all.filter(item=>item.name!=='position')){
      const found=description.properties.find((entry:any)=>entry.name===item.name);
      assert(found?.status==='found'&&found.descriptor.origin==='godotjs_export'&&found.descriptor.type===item.expectedType&&
        found.descriptor.readAccess.status==='candidate'&&found.descriptor.writeAccess.status==='candidate','标准导出属性元数据不符');
    }
    assert(description.properties.find((entry:any)=>entry.name==='internalCounter')?.status==='absent','未导出字段出现在元数据中');
    checks.push({kind:'describe',reply:described});
    const initial=await values(owned);
    assert(equal(initial,{health:100,move_step:64,can_move:true,display_name:'Player 你好',position:{x:64,y:256}}),'初始业务属性不符');
    const before=await capture(owned,100,64,'初始 · health=100 · move_step=64');
    actions.status('正在写入血量并验证实际血条');
    await write(owned,'health','int',100,40);assert((await read(owned,[{name:'health',expectedType:'int'}])).health===40,'血量独立读回失败');
    await capture(owned,40,64,'写入后 · health=40',before);
    await tap(owned,'ArrowRight');assert(equal((await read(owned,[{name:'position',expectedType:'vector2'}])).position,{x:128,y:256}),'默认单次移动距离错误');
    actions.status('正在验证相同输入在调参后的位移');
    await write(owned,'move_step','float',64,128);assert((await read(owned,[{name:'move_step',expectedType:'float'}])).move_step===128,'移动参数独立读回失败');
    await tap(owned,'ArrowDown');assert(equal((await read(owned,[{name:'position',expectedType:'vector2'}])).position,{x:64,y:256}),'位置重置失败');
    await tap(owned,'ArrowRight');assert(equal((await read(owned,[{name:'position',expectedType:'vector2'}])).position,{x:192,y:256}),'调参后单次位移错误');
    await capture(owned,40,192,'同次输入 · Player x=192',before);
  });
  actions.status('正在验证同源码重启恢复及旧运行隔离');
  const second=await withRun(async owned=>{
    assert(owned.run.runId!==first.owned.run.runId&&owned.sourceHash===first.owned.sourceHash,'重启源码或运行身份错误');
    const initial=await values(owned);assert(initial.health===100&&initial.move_step===64&&equal(initial.position,{x:64,y:256}),'重启未恢复初始值');
    const stale=await api.write_runtime_property({...first.owned.target,property:'health',value:{type:'int',value:1}},signal);
    assert(!stale.ok&&stale.error.code==='run_ended','第一轮原目标写入未被拒绝');
    assert((await read(owned,[{name:'health',expectedType:'int'}])).health===100,'旧运行请求影响了新运行');
    checks.push({kind:'stale-write',reply:stale});await capture(owned,100,64,'重启 · health=100 · Player x=64');
  });
  return {...evidence,first:{...first.owned,exit:first.exit},second:{...second.owned,exit:second.exit}};
}

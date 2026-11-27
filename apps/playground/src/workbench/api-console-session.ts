import type {PlaygroundApi} from '../playground-api';
import {summerGameProbeInputError} from '../summer-adapter.ts';
import {DEFAULT_CONSOLE_OPERATION, getConsoleOperation, MAX_CONSOLE_READ_PROPERTIES} from './api-console-catalog.ts';
import type {
  ConsoleAnchor, ConsoleAttachment, ConsoleCall, ConsoleEnvironment, ConsoleFillSelection,
  ConsoleGate, ConsoleHooks, ConsoleOwner, ConsoleResultFacts, ConsoleSession, ConsoleSnapshot, ConsoleToken,
} from './api-console-types';
import type {GameScreenshot} from '@godot-js/engine/browser/dedicated/worker-runner';
import {isWorkerRunIdentity, type WorkerRunIdentity} from '@godot-js/engine/browser/dedicated/worker-protocol';
import type {RuntimeType} from '@godot-js/engine/browser/dedicated/worker-runtime-properties';

const encoder = new TextEncoder();
const INPUT_BYTES = 32 * 1024, RESULT_BYTES = 64 * 1024, FACT_BYTES = 256 * 1024;
const MAX_HISTORY = 20, MAX_IMAGES = 4, IMAGE_BYTES = 20 * 1024 * 1024;
const copy = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const methodTypes = new Set(['bool', 'int', 'float', 'string']);
const runtimeTypes = new Set([...methodTypes, 'vector2']);
function notify(listeners: Set<() => void>) {for (const listener of [...listeners]) {try {listener();} catch { /* UI observers do not change execution. */ }}}

export function createConsoleGate(): ConsoleGate {
  let active: {token: ConsoleToken; owner: ConsoleOwner} | undefined;
  const listeners = new Set<() => void>();
  return {
    acquire(owner) {if (active) return; const token = Symbol(owner);active = {token,owner};notify(listeners);return token;},
    release(token) {if (active?.token !== token) return;active = undefined;notify(listeners);},
    owner: () => active?.owner ?? null,
    subscribe(listener) {listeners.add(listener);return () => {listeners.delete(listener);};},
  };
}

function identity(value: unknown): WorkerRunIdentity | undefined {
  if (!isWorkerRunIdentity(value)) return;
  return {runId:value.runId,buildKey:value.buildKey,documentId:value.documentId,workerId:value.workerId,
    runConfigurationHash:value.runConfigurationHash,revision:value.revision,generation:value.generation};
}
export function stringifyConsoleJson(value: unknown, project: (entry: unknown) => unknown = entry => entry): string {
  const marker = '\0', quotedMarker = '"\\u0000';
  let escaped = false;
  const text = JSON.stringify(value, (_key, item) => {
    const entry = project(item);
    if (Object.is(entry, -0)) {escaped = true; return marker;}
    if (typeof entry === 'string' && entry.startsWith(marker)) {escaped = true; return marker + entry;}
    return entry;
  }, 2);
  if (!escaped) return text;
  // Scan whole JSON string tokens. Leave object keys alone and unescape any
  // original string value that starts with the same marker.
  return text.replace(/"(?:[^"\\]|\\.)*"/g, (token, offset: number) => {
    if (!token.startsWith(quotedMarker) || text[offset + token.length] === ':') return token;
    return token === quotedMarker + '"' ? '-0' : '"' + token.slice(quotedMarker.length);
  });
}
function projection(reply: unknown): {text: string; truncated: boolean} {
  let text: string;
  try {text = stringifyConsoleJson(reply, value => value instanceof ArrayBuffer ? {kind:'ArrayBuffer',byteLength:value.byteLength} :
    ArrayBuffer.isView(value) ? {kind:value.constructor.name,byteLength:value.byteLength} : value) ?? 'undefined';}
  catch {text = '返回值无法投影为 JSON';}
  if (encoder.encode(text).byteLength <= RESULT_BYTES) return {text,truncated:false};
  // UTF-8 truncation without leaving half a surrogate pair in the displayed text.
  let low = 0, high = text.length;
  while (low < high) {const mid = Math.ceil((low+high)/2);if (encoder.encode(text.slice(0,mid)).byteLength <= RESULT_BYTES-64) low=mid;else high=mid-1;}
  if (low && /[\uD800-\uDBFF]/.test(text[low-1])) low--;
  return {text:text.slice(0,low)+'\n…结果展示已截断',truncated:true};
}
function dataFor(operationId: string, reply: unknown): Record<string, any> | undefined {
  if (!object(reply) || reply.ok !== true || !object(reply.result)) return;
  const data = operationId.startsWith('engine.') ? reply.result.data : reply.result;
  return object(data) ? data : undefined;
}
function resultSummary(operationId: string, reply: unknown, displayTruncated: boolean): string {
  if (!object(reply)) return '调用已结算';
  if (reply.ok === false) {
    const code = reply.error?.code;
    if (operationId === 'engine.game_input' && reply.error?.details?.godotai?.receipt?.outcome === 'interrupted')
      return '输入脚本中断，已记录执行边沿和清理回执';
    if (code === 'outcome_unknown') return operationId === 'engine.runtime_call' ? '结果未确认；请先独立观察' : '结果未确认；不得自动重试';
    if (code === 'call_error') return '脚本方法已执行并抛出异常';
    if (code === 'result_unavailable') return '脚本方法已返回，返回值无法编码';
    return `API 拒绝：${code ?? 'unknown'}`;
  }
  const data = dataFor(operationId,reply);
  if (!data) return '调用已结算';
  if (operationId === 'check') return data.status === 'completed' && data.diagnostics?.counts?.error === 0 ? '类型检查通过' : '检查已结算，请查看诊断';
  if (operationId === 'engine.get_diagnostics') {
    const record = (item: Record<string, any> | null) => item === null ? '无记录' :
      item.diagnostics?.observed === true ? `${item.status}，${item.diagnostics.counts.error} 个错误` : `${item.status}，错误数未观测`;
    const run = data.run;
    const runStatus = data.build?.preview?.status === 'rejected' ? '预览准备失败' :
      run === null ? '没有关联会话' : run.availability === 'unavailable' ? '记录不可读' :
      run.exit ? `${run.exit.reason}（${run.exit.evidence}）` : `${run.state}，暂无退出回执`;
    return `检查：${record(data.check)} · 构建：${record(data.build)} · 运行：${runStatus}` +
      (displayTruncated ? ' · 详细结果展示已截断' : '');
  }
  if (operationId === 'engine.play') return '已接纳，待启动';
  if (operationId === 'engine.stop') return data.no_target ? '没有待停止目标' : '停止请求已接纳，退出待确认';
  if (operationId === 'engine.is_running') return data.playing ? '主运行正在运行' : '主运行未处于 running';
  if (operationId === 'engine.game_input') return '输入脚本已完成，使用帧探测验证玩法';
  if (operationId === 'game_input') return '输入已接纳，分发待确认';
  if (operationId === 'wait_for_input') return `输入等待：${data.outcome}；分发：${data.operation?.status ?? 'unknown'}`;
  if (operationId === 'engine.recent_events' || operationId === 'engine.wait_for_event') {
    if (displayTruncated) {
      const limit = operationId === 'engine.recent_events' ? 'limit' : 'max_events';
      return `结果展示已截断。请从结果开头的 since 重新读取，并减小 ${limit}。`;
    }
    const status = data.timed_out ? '等待超时' : `读取到 ${data.events?.length ?? 0} 条事件`;
    return status + (data.gap ? '；历史有缺口' : '') + (data.truncated ? '；可继续翻页' : '');
  }
  if (operationId === 'wait_for_event') return `等待结果：${data.outcome}`;
  const outcome = data.payload?.result?.outcome ?? data.outcome;
  if (outcome === 'completed') return '属性批次已结算，请逐项查看';
  if (typeof outcome === 'string') return `执行结果：${outcome}`;
  if (operationId === 'engine.game_probe') return data.mode === 'rendered' ? '已取得同帧状态和 PNG' : '已取得迭代状态';
  return operationId === 'engine.screenshot' ? '已取得游戏 PNG' : '调用已结算';
}
function resultFacts(call: ConsoleCall, input: unknown, reply: unknown, submittedAnchor: ConsoleAnchor): ConsoleResultFacts | undefined {
  const op = call.draft.operationId, data = dataFor(op,reply);
  if (!data) return;
  // Explicit discovery can submit a current run ID from an older draft.
  const anchor = op === 'describe_runtime_methods' ? submittedAnchor : call.draft.anchor;
  const facts: ConsoleResultFacts = {sourceCallId:call.callId,sourceAnchor:copy(anchor)};
  const runData = op === 'engine.game_input' ? data.receipt?.run : data.run;
  let run = identity(runData);
  if (op === 'wait_for_event' && data.outcome !== 'reached') run = undefined;
  if (run) {
    const projectId = nonempty(runData.projectId) ? runData.projectId :
      anchor.activeRunId === run.runId ? anchor.activeRunProjectId ?? undefined : undefined;
    facts.run = {identity:run,...(projectId ? {projectId} : {}),...(nonempty(runData.attemptId) ? {attemptId:runData.attemptId} : {})};
    facts.sourceAnchor.activeRunId = run.runId;facts.sourceAnchor.activeRunRevision = run.revision;
    facts.sourceAnchor.activeRunProjectId = projectId ?? null;
    const epoch = data.image?.geometry?.epoch;
    if (op === 'engine.game_probe' && Number.isSafeInteger(epoch) && epoch > 0) facts.geometryEpoch = epoch;
  }
  if (!call.truncated && (op === 'engine.recent_events' || op === 'engine.wait_for_event') &&
      nonempty(data.stream_id) && Number.isSafeInteger(data.next_seq) && data.next_seq >= 0) {
    facts.eventCursor = {since: data.next_seq, stream_id: data.stream_id};
  }
  if (op === 'engine.play' && nonempty(data.attemptId)) facts.attemptId=data.attemptId;
  const nodes = op === 'engine.get_runtime_tree' ? data.nodes : op === 'engine.game_probe' ? data.tree?.nodes : undefined;
  if (run && Array.isArray(nodes)) {
    facts.nodes=nodes.filter((node:unknown)=>object(node)&&nonempty(node.path)&&nonempty(node.instanceId)&&nonempty(node.type))
      .slice(0,500).map((node:any)=>({path:node.path,instanceId:node.instanceId,type:node.type}));
    if(nodes.length>500||data.tree?.truncated)facts.truncated=true;
  }
  if ((op === 'describe_runtime_properties' || op === 'describe_runtime_methods') && object(reply) && object(reply.receipt) && object(input) &&
      reply.receipt.run?.runId === input.runId && reply.receipt.path === input.path && reply.receipt.expectedInstanceId === input.expectedInstanceId) {
    const receiptRun=identity(reply.receipt.run);
    if(receiptRun) {
      facts.run={identity:receiptRun,...(anchor.activeRunId===receiptRun.runId&&anchor.activeRunProjectId ? {projectId:anchor.activeRunProjectId} : {})};
      facts.propertyTarget={runId:input.runId,path:input.path,expectedInstanceId:input.expectedInstanceId};
      facts.sourceAnchor.activeRunId=receiptRun.runId;facts.sourceAnchor.activeRunRevision=receiptRun.revision;
      facts.sourceAnchor.activeRunProjectId=facts.run.projectId??null;
      const descriptors=Array.isArray(data.properties)?data.properties:[];
      facts.properties=descriptors.map((item:any)=>data.mode==='names'&&item?.status==='found'?item.descriptor:data.mode==='enumerate'?item:undefined)
        .filter((item:any)=>object(item)&&nonempty(item.name)&&runtimeTypes.has(item.type)).slice(0,64)
        .map((item:any)=>({name:item.name,type:item.type as RuntimeType}));
      if(descriptors.length>64)facts.truncated=true;
      if (op === 'describe_runtime_methods' && Array.isArray(data.methods)) {
        facts.methods = [];
        for (const item of data.methods.slice(0,64)) {
          if (!object(item) || !nonempty(item.method) || !Array.isArray(item.parameterTypes) || item.parameterTypes.length > 8 ||
              !item.parameterTypes.every((type: string) => methodTypes.has(type)) ||
              (item.returnType !== 'void' && !methodTypes.has(item.returnType))) continue;
          const token = item.methodToken;
          if (!object(token) || token.version !== 1 || token.runId !== receiptRun.runId ||
              typeof token.releaseId !== 'string' || token.releaseId !== reply.receipt.releaseId ||
              token.returnType !== item.returnType || typeof token.stamp !== 'string' || !/^[a-f0-9]{64}$/.test(token.stamp)) continue;
          facts.methods.push({name: item.method, signature: `${item.method}(${item.parameterTypes.join(', ')}) → ${item.returnType}`,
            parameterTypes: [...item.parameterTypes],
            token: {version:1,runId:token.runId,releaseId:token.releaseId,returnType:token.returnType,stamp:token.stamp}});
        }
        if (data.truncated) facts.truncated = true;
      }
    }
  }
  if (op === 'game_input' && object(input) && nonempty(input.runId) && nonempty(data.operationId)) facts.input={runId:input.runId,operationId:data.operationId};
  if (op === 'engine.stop' && Array.isArray(data.runs)) {
    facts.stoppedRunIds=data.runs.filter((item:unknown)=>object(item)&&nonempty(item.runId)).slice(0,16).map((item:any)=>item.runId);
    if(data.runs.length>16)facts.truncated=true;
  }
  if (!facts.attemptId && !facts.run && !facts.nodes && !facts.propertyTarget && !facts.input && !facts.stoppedRunIds && !facts.eventCursor) return;
  while(encoder.encode(JSON.stringify(facts)).byteLength>FACT_BYTES) {
    facts.truncated=true;
    if(facts.nodes?.length)facts.nodes.pop();else if(facts.properties?.length)facts.properties.pop();
    else if(facts.stoppedRunIds?.length)facts.stoppedRunIds.pop();else return;
  }
  return facts;
}

/** Both the picker and the draft update require a result that can fill the selected operation. */
export function consoleResultSource(operationId: string, facts: ConsoleResultFacts | undefined) {
  if (!facts) return;
  const hasNode = facts.run && !!facts.nodes?.length;
  switch (operationId) {
    case 'engine.recent_events':
    case 'engine.wait_for_event':
      return facts.eventCursor ? 'event-cursor' : undefined;
    case 'engine.game_probe':
    case 'engine.get_runtime_tree':
    case 'engine.inspect_runtime_node':
    case 'engine.runtime_set':
      return hasNode ? 'node' : undefined;
    case 'engine.runtime_call':
      return facts.propertyTarget && facts.methods?.length ? 'method' : undefined;
    case 'describe_runtime_methods':
      return hasNode ? 'node' : undefined;
    case 'describe_runtime_properties':
      return hasNode ? 'node' : facts.propertyTarget ? 'property-target' : undefined;
    case 'read_runtime_properties':
      return facts.propertyTarget && facts.properties?.length ? 'properties' : hasNode ? 'node' : undefined;
    case 'wait_for_event':
      if (facts.stoppedRunIds?.length) return 'stopped-run';
      if (facts.run) return 'run';
      return facts.attemptId ? 'attempt' : undefined;
    case 'game_input':
    case 'engine.game_input':
    case 'engine.stop':
      return facts.run ? 'run' : undefined;
    case 'wait_for_input':
      return facts.input ? 'input' : undefined;
  }
}

export function createApiConsoleSession(api: PlaygroundApi, hooks: ConsoleHooks, gate: ConsoleGate): ConsoleSession {
  let operationId:string=DEFAULT_CONSOLE_OPERATION, disposed=false, sequence=0;
  const drafts=new Map<string,ConsoleCall['draft']>(),history:ConsoleCall[]=[],attachments=new Map<string,ConsoleAttachment>();
  const listeners=new Set<()=>void>();
  const clientErrors=new Map<string,NonNullable<ConsoleSnapshot['clientError']>>();
  let pending:{callId:string;controller?:AbortController}|undefined;
  function environment():ConsoleEnvironment{return copy(hooks.readContext());}
  function emit(){if(!disposed)notify(listeners);}
  function error(kind:NonNullable<ConsoleSnapshot['clientError']>['kind'],message:string,id=operationId){clientErrors.set(id,{kind,message});emit();}
  function clearError(){clientErrors.delete(operationId);}
  function draft(){
    let value=drafts.get(operationId);
    if(!value){const context=environment();const preset=getConsoleOperation(operationId)!.createPreset(context.anchor);
      value={operationId,inputText:stringifyConsoleJson(preset.input),anchor:context.anchor};drafts.set(operationId,value);}
    return value;
  }
  function dropAttachment(id:string){attachments.delete(id);const row=history.find(item=>item.attachmentId===id);if(row)row.attachmentReleased=true;}
  function removeRow(index:number){const [row]=history.splice(index,1);if(row?.attachmentId)dropAttachment(row.attachmentId);}
  function storeImage(call:ConsoleCall,reply:unknown){
    const op = call.draft.operationId;
    if (op !== 'engine.screenshot' && op !== 'engine.game_probe') return;
    const data = dataFor(op, reply);
    const frame = (op === 'engine.game_probe' && data?.image ? {...data.image, run: data.run, releaseId: data.releaseId, requestId: data.requestId} :
      op === 'engine.screenshot' ? data : undefined) as GameScreenshot | undefined;
    if(!frame||!(frame.bytes instanceof ArrayBuffer)||frame.mimeType!=='image/png')return;
    const {bytes,...metadata}=frame;
    const blob=new Blob([bytes],{type:frame.mimeType});
    if(blob.size>IMAGE_BYTES){call.attachmentReleased=true;return;}
    const size=()=>[...attachments.values()].reduce((total,item)=>total+item.blob.size,0);
    while(attachments.size>=MAX_IMAGES||size()+blob.size>IMAGE_BYTES){const first=attachments.keys().next().value;if(first===undefined)break;dropAttachment(first);}
    const id=call.callId+':png';attachments.set(id,{blob,metadata:copy(metadata)});call.attachmentId=id;
  }
  function parsed():unknown|undefined {
    const text=draft().inputText;
    if(encoder.encode(text).byteLength>INPUT_BYTES){error('json','input 超过 32 KiB');return;}
    try{return JSON.parse(text);}catch{error('json','input 不是有效 JSON');return;}
  }
  function same(anchor:ConsoleAnchor,current:ConsoleAnchor,keys:(keyof ConsoleAnchor)[]){return keys.every(key=>anchor[key]===current[key]);}
  function admissible(input:unknown,current:ConsoleEnvironment):boolean {
    const selected=getConsoleOperation(operationId)!;const original=draft().anchor,now=current.anchor;
    const stale=()=>{error('stale_target','目标已变化，请显式更新目标后提交');return false;};
    if (draft().needsEventCursor && (!object(input) || !Number.isSafeInteger(input.since) || input.since < 0 || !nonempty(input.stream_id))) {
      error('missing_source', '请从操作前的历史回执填入 since 和 stream_id');
      return false;
    }
    if(draft().runSourceCallId===null){error('missing_source','请从运行历史选择本次操作的目标');return false;}
    if(draft().runSourceCallId!==undefined&&(!same(original,now,['editorProjectId','activeRunProjectId','activeRunId','activeRunRevision','pendingAttemptId'])||
      now.pendingAttemptId!==null||current.activeRunState!=='running')){
      error('stale_target','运行已变化，请从当前运行的历史回执重新选择目标');return false;
    }
    if(selected.binding==='project'&&!same(original,now,['editorProjectId','editorRevision']))return stale();
    if(selected.binding==='main'&&!same(original,now,['activeRunId','pendingAttemptId']))return stale();
    if(selected.binding==='runtime'){
      if(!same(original,now,['editorProjectId','editorRevision','activeRunId','pendingAttemptId']))return stale();
      if(now.activeRunId&&now.activeRunProjectId!==now.editorProjectId){error('wrong_project','主运行不属于当前编辑项目');return false;}
      if(now.activeRunId&&(current.activeRunState==='stopping'||current.activeRunState==='exited'))return stale();
    }
    const bound = draft().selectedMethod;
    if (bound && (!object(input) || input.path !== bound.path || input.method !== bound.method)) return stale();
    if(['describe_runtime_properties','describe_runtime_methods','read_runtime_properties','game_input'].includes(operationId)&&object(input)&&
      input.runId===now.activeRunId&&now.activeRunId&&current.activeRunState!=='exited'&&now.activeRunProjectId!==now.editorProjectId){
      error('wrong_project','指定运行不属于当前编辑项目');return false;
    }
    return true;
  }
  const unsubscribeContext=hooks.subscribeContext(emit),unsubscribeGate=gate.subscribe(emit);
  draft();
  return {
    snapshot(){const clientError=clientErrors.get(operationId);return {operationId,draft:copy(draft()),environment:environment(),owner:gate.owner(),history:copy(history),
      ...(pending?{pendingCallId:pending.callId}:{}),cancellable:!!pending?.controller,...(clientError?{clientError:copy(clientError)}:{})};},
    subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},
    selectOperation(id){if(disposed||!getConsoleOperation(id))return;operationId=id;draft();emit();},
    updateDraft(inputText){if(disposed)return;draft().inputText=inputText;clearError();emit();},
    loadPreset(id,inputText,needsRunSource,needsEventCursor){
      if(disposed||!getConsoleOperation(id))return;
      operationId=id;
      const anchor=needsRunSource?draft().anchor:environment().anchor;
      drafts.set(id,{operationId:id,inputText,anchor,...(needsRunSource?{runSourceCallId:null}:{}),
        ...(needsEventCursor ? {needsEventCursor: true} : {})});
      clearError();emit();
    },
    loadHistory(callId){const call=history.find(item=>item.callId===callId);if(disposed||!call)return;operationId=call.draft.operationId;drafts.set(operationId,copy(call.draft));clearError();emit();},
    updateTarget(selection){
      if(disposed)return;
      clearError();
      const input=parsed();if(clientErrors.has(operationId))return;
      const current=environment(),id=operationId;
      if(draft().runSourceCallId!==undefined&&!selection){
        error('missing_source','请从运行历史选择本次操作的目标');return;
      }
      if (id === 'engine.game_probe' && !selection && object(input) && (input.tree?.path !== undefined ||
          Array.isArray(input.props) && input.props.length > 0) &&
          !same(draft().anchor,current.anchor,['editorProjectId','activeRunId'])) {
        error('missing_source','请从当前运行的节点树重新选择目标，原草稿已保留');return;
      }
      if(id.startsWith('engine.')&&!selection){
        if(draft().selectedMethod){error('missing_source','请从当前运行的发现结果重新选择方法');return;}
        draft().anchor=current.anchor;emit();return;
      }
      if(!object(input)){error('missing_source','更新目标需要 input 对象；原文已保留');return;}
      const source=selection?history.find(call=>call.callId===selection.sourceCallId)?.resultFacts:undefined;
      if(selection&&!source){error('missing_source','来源记录已释放或没有可填参事实');return;}
      if(source&&!consoleResultSource(id,source)){
        error('missing_source','此结果没有当前操作需要的参数；原草稿已保留');return;
      }
      const next=copy(input);let anchor=source?copy(source.sourceAnchor):current.anchor;
      const missing=(message:string)=>error('missing_source',message+'；原草稿已保留');
      const node=source?.nodes?.find(item=>item.path===selection?.nodePath);
      const target=node&&source?.run?{runId:source.run.identity.runId,path:node.path,expectedInstanceId:node.instanceId}:source?.propertyTarget;
      if ((id === 'engine.recent_events' || id === 'engine.wait_for_event') && source?.eventCursor) {
        Object.assign(next, source.eventCursor);
      } else if((id==='engine.game_input'||id==='engine.stop')&&selection){
        if(!source?.run||source.run.identity.runId!==current.anchor.activeRunId||
          source.run.identity.revision!==current.anchor.activeRunRevision||current.activeRunState!=='running'||
          source.run.projectId!==current.anchor.editorProjectId||current.anchor.pendingAttemptId!==null||
          source.sourceAnchor.pendingAttemptId!==current.anchor.pendingAttemptId){
          missing('请从当前项目的稳定运行选择回执');return;
        }
        if (id === 'engine.game_input' && source.geometryEpoch && Array.isArray(next.events) &&
            next.events.length === 1 && object(next.events[0]) && next.events[0].type === 'mouse_click')
          next.events[0].geometry_epoch = source.geometryEpoch;
        anchor=current.anchor;
        draft().runSourceCallId=selection.sourceCallId;
      }else if(id==='check'){
        if(!current.anchor.editorProjectId||current.anchor.editorRevision===null){missing('尚缺当前编辑项目');return;}
        next.projectId=current.anchor.editorProjectId;next.expectedEditorRevision=current.anchor.editorRevision;anchor=current.anchor;
      }else if(id==='wait_for_event'){
        const keepExitTarget=!source&&next.until==='exited'&&(
          nonempty(next.runId)&&next.attemptId===undefined || nonempty(next.attemptId)&&next.runId===undefined);
        if(!keepExitTarget){
          const stopped=selection?.stoppedRunId&&source?.stoppedRunIds?.includes(selection.stoppedRunId)?selection.stoppedRunId:undefined;
          const runId=stopped??source?.run?.identity.runId;
          const attemptId=source?.attemptId??(!source&&next.until==='running'?current.anchor.pendingAttemptId:undefined);
          if(runId){delete next.attemptId;next.runId=runId;if(stopped)next.until='exited';}
          else if(attemptId){delete next.runId;next.attemptId=attemptId;}
          else if(!source&&current.anchor.activeRunId){delete next.attemptId;next.runId=current.anchor.activeRunId;}
          else {missing('尚缺 attempt 或 run 来源');return;}
        }
      }else if(id==='engine.runtime_call'){
        const method=source?.methods?.find(item=>item.name===selection?.methodName);
        if(!target||!method||target.runId!==current.anchor.activeRunId){
          missing('请从当前运行的发现结果选择方法');return;
        }
        next.path=target.path;next.method=method.name;
        draft().selectedMethod={...target,method:method.name,methodToken:copy(method.token),parameterTypes:copy(method.parameterTypes)};
      }else if(id==='describe_runtime_properties'||id==='describe_runtime_methods'||id==='read_runtime_properties'){
        const changesTarget=target&&(target.runId!==next.runId||target.path!==next.path||target.expectedInstanceId!==next.expectedInstanceId);
        if(id==='read_runtime_properties'&&!source?.properties&&(changesTarget||!Array.isArray(next.properties)||next.properties.length===0)){
          missing('请先 describe 新目标，选择实际属性类型后再读取');return;
        }
        if(target){Object.assign(next,target);}
        else if(!source&&next.runId===current.anchor.activeRunId&&nonempty(next.path)&&nonempty(next.expectedInstanceId)) { /* Keep an explicitly entered same-run target. */ }
        else {missing('请从该次运行重新选择节点');return;}
        if(id==='read_runtime_properties'&&source?.properties){
          const names=selection?.propertyNames??source.properties.map(item=>item.name);
          if(names.length>MAX_CONSOLE_READ_PROPERTIES){missing(`每次最多 ${MAX_CONSOLE_READ_PROPERTIES} 项属性`);return;}
          const properties=source.properties.filter(item=>names.includes(item.name));
          if(!properties.length||properties.length!==names.length){missing('请先选择实际发现的属性');return;}
          next.properties=properties.map(item=>({name:item.name,expectedType:item.type}));
        }
      }else if(id==='game_input'){
        const runId=source?.run?.identity.runId??(!source?current.anchor.activeRunId:undefined);
        if(!runId){missing('尚缺运行来源');return;}next.runId=runId;
      }else if(id==='wait_for_input'){
        if(source?.input){next.runId=source.input.runId;next.operationId=source.input.operationId;}
        else if(!source&&next.runId===current.anchor.activeRunId&&nonempty(next.operationId)) { /* No rebind to another run. */ }
        else {missing('请使用该次运行的输入回执');return;}
      }else if(id==='engine.game_probe'&&selection){
        if(!node||!source?.run||source.run.identity.runId!==current.anchor.activeRunId||
          source.run.projectId!==current.anchor.editorProjectId){
          missing('请从当前项目的当前运行选择节点');return;
        }
        const changedRun = draft().anchor.activeRunId !== current.anchor.activeRunId ||
          draft().anchor.editorProjectId !== current.anchor.editorProjectId;
        if (selection.probeTarget === 'tree') {
          if (next.tree !== undefined && !object(next.tree)) {missing('tree 需要对象');return;}
          if (changedRun && Array.isArray(next.props) && next.props.length) {missing('请先移除旧运行的属性路径');return;}
          next.tree = {...next.tree, path:node.path};
        } else {
          if (next.props !== undefined && (!Array.isArray(next.props) || !next.props.every((prop: unknown) => typeof prop === 'string'))) {
            missing('props 需要字符串数组');return;
          }
          if (changedRun && (next.tree?.path || next.props?.length)) {missing('请先移除旧运行的路径');return;}
          const props = [...new Set([...(next.props ?? []), node.path+':position', node.path+':visible'])];
          if (props.length>16) {missing('每次最多 16 项属性');return;}
          next.props=props;
        }
        const invalid = summerGameProbeInputError(next);
        if (invalid) {
          missing(invalid.message === invalid.code ? '探测参数超出支持范围或无效' : invalid.message);
          return;
        }
        anchor=current.anchor;
      }else if(['engine.get_runtime_tree','engine.inspect_runtime_node','engine.runtime_set'].includes(id)&&selection){
        if(!node||!source?.run){missing('请从运行树选择实际节点');return;}
        next.path=node.path;
      }
      draft().inputText=stringifyConsoleJson(next);draft().anchor=copy(anchor);emit();
    },
    async submit(){
      if(disposed)return;
      clearError();const input=parsed();if(clientErrors.has(operationId))return;
      const token=gate.acquire('manual');if(!token){error('missing_source','另一个调用或自动验证尚未结束');return;}
      let call:ConsoleCall|undefined;
      try {
        const current=environment();if(!admissible(input,current))return;
        const selected=getConsoleOperation(operationId)!;
        call={callId:'console-'+ ++sequence,draft:copy(draft()),submittedAt:Date.now(),phase:'pending'};
        while(history.length>=MAX_HISTORY){const index=history.findIndex(item=>item.phase!=='pending');if(index<0)break;removeRow(index);}
        history.push(call);
        const controller=selected.acceptsSignal?new AbortController():undefined;pending={callId:call.callId,controller};
        // Keep the last target check and API submission in the same synchronous turn.
        const bound = call.draft.selectedMethod;
        const returned=bound ? hooks.callSelectedMethod(input,controller?.signal,bound) : selected.invoke(api,input,controller?.signal);emit();
        const reply=await returned;
        if(disposed)return;
        const projected=projection(reply);call.phase='settled';call.settledAt=Date.now();call.summary=resultSummary(call.draft.operationId,reply,projected.truncated);
        call.resultProjection=projected.text;if(projected.truncated)call.truncated=true;
        call.resultFacts=resultFacts(call,input,reply,current.anchor);storeImage(call,reply);
      }catch(caught){
        if(!disposed&&call){call.phase='thrown';call.settledAt=Date.now();call.summary='调用异常；不代表未执行';
          call.resultProjection=projection({exception:caught instanceof Error?caught.message:typeof caught==='string'?caught:'未知调用异常'}).text;}
      }finally{if(pending?.callId===call?.callId)pending=undefined;gate.release(token);emit();}
    },
    cancel(){pending?.controller?.abort();},
    async openExample(){
      if(disposed)return;const token=gate.acquire('open-example');if(!token){error('missing_source','调用或自动验证结束后才能打开示例');return;}
      const id=operationId;clearError();
      try{await hooks.openExample(id);}catch(caught){if(!disposed)error('missing_source',caught instanceof Error?caught.message:'打开示例失败',id);}
      finally{gate.release(token);emit();}
    },
    hasCall(callId){return history.some(call=>call.callId===callId);},
    getAttachment(id){const attachment=attachments.get(id);return attachment?{blob:attachment.blob,metadata:copy(attachment.metadata)}:undefined;},
    clearSettled(){for(let index=history.length-1;index>=0;index--)if(history[index].phase!=='pending')removeRow(index);clearError();emit();},
    dispose(){if(disposed)return;disposed=true;pending?.controller?.abort();unsubscribeContext();unsubscribeGate();listeners.clear();attachments.clear();history.length=0;drafts.clear();clientErrors.clear();},
  };
}

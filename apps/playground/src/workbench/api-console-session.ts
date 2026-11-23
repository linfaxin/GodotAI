import type {PlaygroundApi} from '../playground-api';
import {getConsoleOperation, MAX_CONSOLE_READ_PROPERTIES} from './api-console-catalog.ts';
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
const runtimeTypes = new Set(['bool', 'int', 'float', 'string', 'vector2']);
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
function projection(reply: unknown): {text: string; truncated: boolean} {
  let text: string;
  try {text = JSON.stringify(reply, (_key, value) => value instanceof ArrayBuffer ? {kind:'ArrayBuffer',byteLength:value.byteLength} :
    ArrayBuffer.isView(value) ? {kind:value.constructor.name,byteLength:value.byteLength} : value, 2) ?? 'undefined';}
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
function resultSummary(operationId: string, reply: unknown): string {
  if (!object(reply)) return '调用已结算';
  if (reply.ok === false) return reply.error?.code === 'outcome_unknown' ? '结果未确认；不得自动重试' : `API 拒绝：${reply.error?.code ?? 'unknown'}`;
  const data = dataFor(operationId,reply);
  if (!data) return '调用已结算';
  if (operationId === 'check') return data.status === 'completed' && data.diagnostics?.counts?.error === 0 ? '类型检查通过' : '检查已结算，请查看诊断';
  if (operationId === 'engine.play') return '已接纳，待启动';
  if (operationId === 'engine.stop') return data.no_target ? '没有待停止目标' : '停止请求已接纳，退出待确认';
  if (operationId === 'engine.is_running') return data.playing ? '主运行正在运行' : '主运行未处于 running';
  if (operationId === 'game_input') return '输入已接纳，分发待确认';
  if (operationId === 'wait_for_input') return `输入等待：${data.outcome}；分发：${data.operation?.status ?? 'unknown'}`;
  if (operationId === 'wait_for_event') return `等待结果：${data.outcome}`;
  const outcome = data.payload?.result?.outcome ?? data.outcome;
  if (outcome === 'completed') return '属性批次已结算，请逐项查看';
  if (typeof outcome === 'string') return `执行结果：${outcome}`;
  return operationId === 'engine.screenshot' ? '已取得游戏 PNG' : '调用已结算';
}
function resultFacts(call: ConsoleCall, input: unknown, reply: unknown): ConsoleResultFacts | undefined {
  const op = call.draft.operationId, data = dataFor(op,reply);
  if (!data) return;
  const facts: ConsoleResultFacts = {sourceCallId:call.callId,sourceAnchor:copy(call.draft.anchor)};
  let run = identity(data.run);
  if (op === 'wait_for_event' && data.outcome !== 'reached') run = undefined;
  if (run) {
    const projectId = nonempty(data.run.projectId) ? data.run.projectId :
      call.draft.anchor.activeRunId === run.runId ? call.draft.anchor.activeRunProjectId ?? undefined : undefined;
    facts.run = {identity:run,...(projectId ? {projectId} : {}),...(nonempty(data.run.attemptId) ? {attemptId:data.run.attemptId} : {})};
    facts.sourceAnchor.activeRunId = run.runId;facts.sourceAnchor.activeRunRevision = run.revision;
    facts.sourceAnchor.activeRunProjectId = projectId ?? null;
  }
  if (op === 'engine.play' && nonempty(data.attemptId)) facts.attemptId=data.attemptId;
  if (op === 'engine.get_runtime_tree' && run && Array.isArray(data.nodes)) {
    facts.nodes=data.nodes.filter((node:unknown)=>object(node)&&nonempty(node.path)&&nonempty(node.instanceId)&&nonempty(node.type))
      .slice(0,500).map((node:any)=>({path:node.path,instanceId:node.instanceId,type:node.type}));
    if(data.nodes.length>500)facts.truncated=true;
  }
  if (op === 'describe_runtime_properties' && object(reply) && object(reply.receipt) && object(input) &&
      reply.receipt.run?.runId === input.runId && reply.receipt.path === input.path && reply.receipt.expectedInstanceId === input.expectedInstanceId) {
    const receiptRun=identity(reply.receipt.run);
    if(receiptRun) {
      facts.run={identity:receiptRun,...(call.draft.anchor.activeRunId===receiptRun.runId&&call.draft.anchor.activeRunProjectId ? {projectId:call.draft.anchor.activeRunProjectId} : {})};
      facts.propertyTarget={runId:input.runId,path:input.path,expectedInstanceId:input.expectedInstanceId};
      facts.sourceAnchor.activeRunId=receiptRun.runId;facts.sourceAnchor.activeRunRevision=receiptRun.revision;
      facts.sourceAnchor.activeRunProjectId=facts.run.projectId??null;
      const descriptors=Array.isArray(data.properties)?data.properties:[];
      facts.properties=descriptors.map((item:any)=>data.mode==='names'&&item?.status==='found'?item.descriptor:data.mode==='enumerate'?item:undefined)
        .filter((item:any)=>object(item)&&nonempty(item.name)&&runtimeTypes.has(item.type)).slice(0,64)
        .map((item:any)=>({name:item.name,type:item.type as RuntimeType}));
      if(descriptors.length>64)facts.truncated=true;
    }
  }
  if (op === 'game_input' && object(input) && nonempty(input.runId) && nonempty(data.operationId)) facts.input={runId:input.runId,operationId:data.operationId};
  if (op === 'engine.stop' && Array.isArray(data.runs)) {
    facts.stoppedRunIds=data.runs.filter((item:unknown)=>object(item)&&nonempty(item.runId)).slice(0,16).map((item:any)=>item.runId);
    if(data.runs.length>16)facts.truncated=true;
  }
  if (!facts.attemptId && !facts.run && !facts.nodes && !facts.propertyTarget && !facts.input && !facts.stoppedRunIds) return;
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
    case 'engine.get_runtime_tree':
    case 'engine.inspect_runtime_node':
    case 'engine.runtime_set':
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
      return facts.run ? 'run' : undefined;
    case 'wait_for_input':
      return facts.input ? 'input' : undefined;
  }
}

export function createApiConsoleSession(api: PlaygroundApi, hooks: ConsoleHooks, gate: ConsoleGate): ConsoleSession {
  let operationId='engine.get_project_context', disposed=false, sequence=0;
  const drafts=new Map<string,ConsoleCall['draft']>(),history:ConsoleCall[]=[],attachments=new Map<string,ConsoleAttachment>();
  const listeners=new Set<()=>void>();
  let clientError:ConsoleSnapshot['clientError'];
  let pending:{callId:string;controller?:AbortController}|undefined;
  function environment():ConsoleEnvironment{return copy(hooks.readContext());}
  function emit(){if(!disposed)notify(listeners);}
  function error(kind:NonNullable<ConsoleSnapshot['clientError']>['kind'],message:string){clientError={kind,message};emit();}
  function draft(){
    let value=drafts.get(operationId);
    if(!value){const context=environment();const preset=getConsoleOperation(operationId)!.createPreset(context.anchor);
      value={operationId,inputText:JSON.stringify(preset.input,null,2),anchor:context.anchor};drafts.set(operationId,value);}
    return value;
  }
  function dropAttachment(id:string){attachments.delete(id);const row=history.find(item=>item.attachmentId===id);if(row)row.attachmentReleased=true;}
  function removeRow(index:number){const [row]=history.splice(index,1);if(row?.attachmentId)dropAttachment(row.attachmentId);}
  function storeImage(call:ConsoleCall,reply:unknown){
    if(call.draft.operationId!=='engine.screenshot')return;
    const frame=dataFor(call.draft.operationId,reply) as GameScreenshot|undefined;
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
    if(selected.binding==='project'&&!same(original,now,['editorProjectId','editorRevision']))return stale();
    if(selected.binding==='main'&&!same(original,now,['activeRunId','pendingAttemptId']))return stale();
    if(selected.binding==='runtime'){
      if(!same(original,now,['editorProjectId','editorRevision','activeRunId','pendingAttemptId']))return stale();
      if(now.activeRunId&&now.activeRunProjectId!==now.editorProjectId){error('wrong_project','主运行不属于当前编辑项目');return false;}
      if(now.activeRunId&&(current.activeRunState==='stopping'||current.activeRunState==='exited'))return stale();
    }
    if(['describe_runtime_properties','read_runtime_properties','game_input'].includes(operationId)&&object(input)&&
      input.runId===now.activeRunId&&now.activeRunId&&current.activeRunState!=='exited'&&now.activeRunProjectId!==now.editorProjectId){
      error('wrong_project','指定运行不属于当前编辑项目');return false;
    }
    return true;
  }
  const unsubscribeContext=hooks.subscribeContext(emit),unsubscribeGate=gate.subscribe(emit);
  draft();
  return {
    snapshot(){return {operationId,draft:copy(draft()),environment:environment(),owner:gate.owner(),history:copy(history),
      ...(pending?{pendingCallId:pending.callId}:{}),cancellable:!!pending?.controller,...(clientError?{clientError:copy(clientError)}:{})};},
    subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},
    selectOperation(id){if(disposed||!getConsoleOperation(id))return;operationId=id;draft();clientError=undefined;emit();},
    updateDraft(inputText){if(disposed)return;draft().inputText=inputText;clientError=undefined;emit();},
    loadPreset(id,inputText){if(disposed||!getConsoleOperation(id))return;operationId=id;drafts.set(id,{operationId:id,inputText,anchor:environment().anchor});clientError=undefined;emit();},
    loadHistory(callId){const call=history.find(item=>item.callId===callId);if(disposed||!call)return;operationId=call.draft.operationId;drafts.set(operationId,copy(call.draft));clientError=undefined;emit();},
    updateTarget(selection){
      if(disposed)return;
      clientError=undefined;
      const input=parsed();if(clientError)return;
      const current=environment(),id=operationId;
      if(id.startsWith('engine.')&&!selection){draft().anchor=current.anchor;clientError=undefined;emit();return;}
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
      if(id==='check'){
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
      }else if(id==='describe_runtime_properties'||id==='read_runtime_properties'){
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
      }else if(['engine.get_runtime_tree','engine.inspect_runtime_node','engine.runtime_set'].includes(id)&&selection){
        if(!node||!source?.run){missing('请从运行树选择实际节点');return;}
        next.path=node.path;
      }
      draft().inputText=JSON.stringify(next,null,2);draft().anchor=copy(anchor);clientError=undefined;emit();
    },
    async submit(){
      if(disposed)return;
      clientError=undefined;const input=parsed();if(clientError)return;
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
        const returned=selected.invoke(api,input,controller?.signal);emit();
        const reply=await returned;
        if(disposed)return;
        const projected=projection(reply);call.phase='settled';call.settledAt=Date.now();call.summary=resultSummary(call.draft.operationId,reply);
        call.resultProjection=projected.text;if(projected.truncated)call.truncated=true;
        call.resultFacts=resultFacts(call,input,reply);storeImage(call,reply);
      }catch(caught){
        if(!disposed&&call){call.phase='thrown';call.settledAt=Date.now();call.summary='调用异常；不代表未执行';
          call.resultProjection=projection({exception:caught instanceof Error?caught.message:typeof caught==='string'?caught:'未知调用异常'}).text;}
      }finally{if(pending?.callId===call?.callId)pending=undefined;gate.release(token);emit();}
    },
    cancel(){pending?.controller?.abort();},
    async openExample(){
      if(disposed)return;const token=gate.acquire('open-example');if(!token){error('missing_source','调用或自动验证结束后才能打开示例');return;}
      clientError=undefined;
      try{await hooks.openExample();}catch(caught){if(!disposed)error('missing_source',caught instanceof Error?caught.message:'打开示例失败');}
      finally{gate.release(token);emit();}
    },
    getAttachment(id){const attachment=attachments.get(id);return attachment?{blob:attachment.blob,metadata:copy(attachment.metadata)}:undefined;},
    clearSettled(){for(let index=history.length-1;index>=0;index--)if(history[index].phase!=='pending')removeRow(index);clientError=undefined;emit();},
    dispose(){if(disposed)return;disposed=true;pending?.controller?.abort();unsubscribeContext();unsubscribeGate();listeners.clear();attachments.clear();history.length=0;drafts.clear();},
  };
}

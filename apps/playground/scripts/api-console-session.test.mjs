import test from 'node:test';
import assert from 'node:assert/strict';
import {createConsoleFixture,consoleEnvironment,consoleIdentity,consoleScreenshot,consoleNode} from './fixtures/api-console-fixture.ts';
import {createConsoleGate} from '../src/workbench/api-console-session.ts';

const copy=value=>structuredClone(value);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const changeRun=(runId='run-2')=>({...copy(consoleEnvironment),anchor:{...consoleEnvironment.anchor,activeRunId:runId}});
const last=f=>f.session.snapshot().history.at(-1);

test('gate keeps ownership through cancellation and ignores stale releases',()=>{
  const gate=createConsoleGate(),first=gate.acquire('manual');assert(first);
  assert.equal(gate.acquire('replay'),undefined);gate.release(Symbol('manual'));assert.equal(gate.owner(),'manual');
  gate.release(first);const second=gate.acquire('replay');gate.release(first);assert.equal(gate.owner(),'replay');gate.release(second);
});

test('each operation retains its exact draft; invalid JSON and oversized input make no API calls',async()=>{
  const f=createConsoleFixture();f.session.updateDraft('{ broken');f.session.selectOperation('check');
  f.session.updateDraft('{"projectId":"custom","expectedEditorRevision":2}');f.session.selectOperation('engine.get_project_context');
  assert.equal(f.session.snapshot().draft.inputText,'{ broken');await f.session.submit();
  assert.equal(f.calls.length,0);assert.equal(f.session.snapshot().history.length,0);assert.equal(f.session.snapshot().clientError.kind,'json');
  f.session.updateDraft(JSON.stringify({text:'界'.repeat(12000)}));await f.session.submit();assert.equal(f.calls.length,0);
  f.session.dispose();
});

test('Summer request stays bound to its draft until an explicit target update',async()=>{
  const f=createConsoleFixture();f.session.selectOperation('engine.runtime_set');
  f.session.updateDraft('{"path":"/root/Main/Player","property":"health","value":40}');
  f.setContext(changeRun());await f.session.submit();assert.equal(f.calls.length,0);assert.equal(f.session.snapshot().clientError.kind,'stale_target');
  f.session.updateTarget();await f.session.submit();assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].input,{op:'engine.runtime_set',input:{path:'/root/Main/Player',property:'health',value:40}});
  assert.equal(last(f).draft.anchor.activeRunId,'run-2');f.session.dispose();
});

test('a write draft with content only accepts a receipt for the same file and base', async () => {
  const {session, setReply, setContext} = createConsoleFixture();
  const path = 'res://src/start.ts', content = 'const startupBroken = false;';
  async function read(projectId, editorRevision, sha256) {
    setContext({...consoleEnvironment, anchor: {...consoleEnvironment.anchor, editorProjectId: projectId, editorRevision}});
    setReply('summer_call', {ok: true, result: {data: {path, projectId, editorRevision, sha256}}});
    session.loadPreset('engine.read_file', JSON.stringify({path}));
    await session.submit();
    return {sourceCallId: session.snapshot().history.at(-1).callId};
  }
  const first = await read('project-1', 7, 'a'.repeat(64));
  session.loadPreset('engine.write_file', JSON.stringify({path, content}));
  session.updateTarget(first);
  const writeDraft = () => JSON.parse(session.snapshot().draft.inputText);
  assert.equal(writeDraft().content, content);

  const refreshed = await read('project-1', 8, 'b'.repeat(64));
  session.selectOperation('engine.write_file');
  const original = session.snapshot().draft;
  session.updateTarget(refreshed);
  assert.equal(session.snapshot().clientError?.kind, 'missing_source');
  assert.deepEqual(session.snapshot().draft, original);
  session.updateDraft(JSON.stringify({path}));
  session.updateTarget(refreshed);
  assert.deepEqual(writeDraft(), {path, projectId: 'project-1', expectedEditorRevision: 8, expected_sha256: 'b'.repeat(64)});

  session.updateDraft(JSON.stringify({...writeDraft(), content}));
  const sameFile = await read('project-1', 9, 'b'.repeat(64));
  session.selectOperation('engine.write_file');
  session.updateTarget(sameFile);
  assert.equal(writeDraft().content, content);

  const switched = await read('project-2', 10, 'b'.repeat(64));
  session.selectOperation('engine.write_file');
  const previousProject = session.snapshot().draft;
  session.updateTarget(switched);
  assert.equal(session.snapshot().clientError?.kind, 'missing_source');
  assert.deepEqual(session.snapshot().draft, previousProject);
  session.dispose();
});

test('updating context cannot attach a newer read receipt to unguarded file content', async () => {
  const {session, setReply, setContext} = createConsoleFixture();
  const path = 'res://src/start.ts', sha256 = 'b'.repeat(64);
  session.loadPreset('engine.write_file', JSON.stringify({path, content: 'const rate = 60;'}));
  const original = session.snapshot().draft;
  setContext({...consoleEnvironment, anchor: {...consoleEnvironment.anchor, editorRevision: 8}});
  session.updateTarget();
  assert.equal(session.snapshot().clientError?.kind, 'missing_source');
  assert.deepEqual(session.snapshot().draft, original);

  setReply('summer_call', {ok: true, result: {data: {path, projectId: 'project-1', editorRevision: 8, sha256}}});
  session.loadPreset('engine.read_file', JSON.stringify({path}));
  await session.submit();
  const sourceCallId = session.snapshot().history.at(-1).callId;
  session.selectOperation('engine.write_file');
  session.updateTarget({sourceCallId});
  assert.equal(session.snapshot().clientError?.kind, 'missing_source');
  assert.deepEqual(session.snapshot().draft, original);
  session.dispose();
});

test('input lesson requires a history receipt for the current stable run and fills without execution', async () => {
  const f = createConsoleFixture();
  f.session.selectOperation('engine.get_runtime_tree');
  await f.session.submit();
  const first = last(f);
  f.session.loadPreset('engine.game_input', '{"action":"script"}', true);
  await f.session.submit();
  assert.equal(f.session.snapshot().clientError.kind, 'missing_source');
  f.setContext(changeRun());
  f.session.updateTarget({sourceCallId: first.callId});
  assert.equal(f.session.snapshot().clientError.kind, 'missing_source');
  await f.session.submit();
  assert.equal(f.calls.length, 1);
  f.setContext(consoleEnvironment);
  f.session.updateTarget({sourceCallId: first.callId});
  assert.equal(f.session.snapshot().clientError, undefined);
  assert.equal(f.calls.length, 1);
  await f.session.submit();
  assert.equal(f.calls.length, 2);
  const bound = last(f);
  assert.equal(bound.draft.anchor.activeRunId, first.resultFacts.run.identity.runId);
  assert.equal(bound.draft.runSourceCallId, first.callId);
  f.setContext(changeRun());
  f.session.loadHistory(bound.callId);
  f.session.updateTarget();
  assert.equal(f.session.snapshot().clientError.kind, 'missing_source');
  await f.session.submit();
  assert.equal(f.session.snapshot().clientError.kind, 'stale_target');
  assert.equal(f.calls.length, 2);
  const nextRun = {...consoleIdentity,runId:'run-2'};
  f.setReply('summer_call', {ok:true,result:{data:{run:nextRun,nodes:[consoleNode]}}});
  f.session.loadPreset('engine.get_runtime_tree', '{}');
  await f.session.submit();
  const second = last(f);
  f.session.loadHistory(bound.callId);
  f.session.updateTarget({sourceCallId:second.callId});
  assert.equal(f.session.snapshot().draft.runSourceCallId, second.callId);
  assert.equal(f.calls.length, 3);
  await f.session.submit();
  assert.equal(f.calls.length, 4);
  assert.equal(last(f).draft.anchor.activeRunId, nextRun.runId);
  f.session.dispose();
});

test('runtime draft detects editor edits and pending replacement while an older source run may be explicitly rebound',async()=>{
  const f=createConsoleFixture();f.session.selectOperation('engine.screenshot');
  f.setContext({...copy(consoleEnvironment),anchor:{...consoleEnvironment.anchor,editorRevision:8,pendingAttemptId:'build-next'}});
  await f.session.submit();assert.equal(f.calls.length,0);
  f.session.updateTarget();await f.session.submit();assert.equal(f.calls.length,1);assert.equal(last(f).draft.anchor.activeRunRevision,7);f.session.dispose();
});

test('known live foreign runs are blocked for script reads and input, but explicit stale IDs reach the real API',async()=>{
  for(const op of ['describe_runtime_properties','read_runtime_properties','game_input']){
    const f=createConsoleFixture();f.setContext({...copy(consoleEnvironment),anchor:{...consoleEnvironment.anchor,editorProjectId:'project-other'}});
    f.session.selectOperation(op);f.session.updateDraft('{"runId":"run-1","path":"/root/Main/Player","expectedInstanceId":"12345"}');
    await f.session.submit();assert.equal(f.calls.length,0);assert.equal(f.session.snapshot().clientError.kind,'wrong_project');
    f.session.updateDraft('{"runId":"old-run"}');await f.session.submit();assert.equal(f.calls.length,1);assert.equal(f.calls[0].input.runId,'old-run');f.session.dispose();
  }
});

test('updating a wait target keeps explicit exits and only selects a pending replacement for startup',async()=>{
  const f=createConsoleFixture();
  const exiting={runId:'run-1',until:'exited',timeoutMs:1234};
  const context=changeRun();context.anchor.pendingAttemptId='replacement';
  f.setContext(context);
  for(const [input,expected] of [
    [exiting,exiting],
    [{attemptId:'original',until:'exited'},{attemptId:'original',until:'exited'}],
    [{until:'exited'},{until:'exited',runId:'run-2'}],
    [{runId:'run-1',until:'running'},{until:'running',attemptId:'replacement'}],
  ]){
    f.session.loadPreset('wait_for_event',JSON.stringify(input));
    f.session.updateTarget();await f.session.submit();
    assert.deepEqual(f.calls.at(-1).input,expected);
  }
  f.setContext({...context,anchor:{...context.anchor,activeRunId:null},activeRunState:null});
  f.session.loadPreset('wait_for_event','{"until":"exited"}');
  f.session.updateTarget();
  assert.equal(f.session.snapshot().clientError.kind,'missing_source');
  assert.equal(f.session.snapshot().draft.inputText,'{"until":"exited"}');
  f.session.dispose();
});

test('one manual call owns its immutable history while editing the next draft, and cancel does not release the gate',async()=>{
  const f=createConsoleFixture(),work=deferred();f.session.selectOperation('wait_for_event');
  f.session.updateDraft('{"runId":"run-1","until":"exited"}');f.setReply('wait_for_event',()=>work.promise);
  const running=f.session.submit();assert.equal(f.gate.owner(),'manual');assert.equal(last(f).phase,'pending');
  f.session.updateDraft('{"runId":"run-next","until":"running"}');f.session.cancel();
  assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.gate.owner(),'manual');
  await f.session.submit();assert.equal(f.calls.length,1);f.session.clearSettled();assert.equal(f.session.snapshot().history.length,1);
  work.resolve({ok:false,error:{code:'cancelled',message:'cancelled'}});await running;
  assert.equal(f.gate.owner(),null);assert.equal(last(f).phase,'settled');assert.match(last(f).draft.inputText,/run-1/);
  assert.match(f.session.snapshot().draft.inputText,/run-next/);f.session.dispose();
});

test('sync input and async check receive no signal and accepted input is never called dispatched',async()=>{
  const f=createConsoleFixture();f.session.selectOperation('check');await f.session.submit();
  assert.equal(f.calls[0].signal,undefined);assert.equal(last(f).summary,'类型检查通过');
  f.session.selectOperation('game_input');await f.session.submit();assert.equal(f.calls[1].signal,undefined);
  assert.match(last(f).summary,/待确认/);assert.deepEqual(last(f).resultFacts.input,{runId:'run-1',operationId:'input-1'});f.session.dispose();
});

test('tree and descriptor facts fill explicit node/type pairs without parsing display JSON',async()=>{
  const f=createConsoleFixture();f.session.selectOperation('engine.get_runtime_tree');await f.session.submit();const tree=last(f);
  f.session.selectOperation('describe_runtime_properties');f.session.updateTarget({sourceCallId:tree.callId,nodePath:consoleNode.path});
  assert.deepEqual(JSON.parse(f.session.snapshot().draft.inputText).expectedInstanceId,'12345');await f.session.submit();const description=last(f);
  f.session.selectOperation('read_runtime_properties');f.session.updateTarget({sourceCallId:description.callId,propertyNames:['health']});
  assert.deepEqual(JSON.parse(f.session.snapshot().draft.inputText),{runId:'run-1',path:consoleNode.path,expectedInstanceId:'12345',properties:[{name:'health',expectedType:'int'}]});
  f.setContext(changeRun());f.session.updateTarget();assert.equal(f.session.snapshot().clientError.kind,'missing_source');
  assert.equal(JSON.parse(f.session.snapshot().draft.inputText).runId,'run-1');f.session.dispose();
});

test('probe fill uses the expanded native request byte budget and leaves a rejected draft intact', async () => {
  const f = createConsoleFixture();
  f.session.selectOperation('engine.get_runtime_tree');
  await f.session.submit();
  const source = {sourceCallId: last(f).callId, nodePath: consoleNode.path, probeTarget: 'properties'};
  const props = Array.from({length: 14}, (_, index) => '/root/Main/' + String(index).padStart(249, 'n') + ':position');
  const withTarget = [...props, consoleNode.path + ':position', consoleNode.path + ':visible'];
  const compact = JSON.stringify({props: withTarget, screenshot: true});
  const expanded = JSON.stringify({props: withTarget.map(entry => {
    const [path, property] = entry.split(':');
    return {path, property};
  }), screenshot: true, maxDimension: 1024});
  assert(Buffer.byteLength(compact) < 4096 && Buffer.byteLength(expanded) > 4096);
  const sourceText = JSON.stringify({props, screenshot: true});
  f.session.loadPreset('engine.game_probe', sourceText);
  f.session.updateTarget(source);
  assert.equal(f.session.snapshot().draft.inputText, sourceText);
  assert.match(f.session.snapshot().clientError.message, /4 KiB/);
  props.pop();
  f.session.updateDraft(JSON.stringify({props, screenshot: true}));
  f.session.updateTarget(source);
  assert.equal(f.session.snapshot().clientError, undefined);
  assert.deepEqual(JSON.parse(f.session.snapshot().draft.inputText).props, withTarget.filter((_, index) => index !== 13));
  assert.equal(f.calls.length, 1);
  f.session.dispose();
});

test('manual method discovery binds its result to the submission context',async()=>{
  const f=createConsoleFixture(),work=deferred();
  f.session.selectOperation('describe_runtime_methods');
  const run={...consoleIdentity,runId:'run-2',revision:8};
  const anchor={...consoleEnvironment.anchor,editorProjectId:'project-2',editorRevision:8,
    activeRunId:run.runId,activeRunProjectId:'project-2',activeRunRevision:run.revision};
  const current={...consoleEnvironment,anchor};
  f.setContext(current);
  const target={runId:run.runId,path:consoleNode.path,expectedInstanceId:consoleNode.instanceId};
  const releaseId='b'.repeat(64),methodToken={version:1,runId:run.runId,releaseId,returnType:'int',stamp:'a'.repeat(64)};
  f.session.updateDraft(JSON.stringify(target));
  f.setReply('describe_runtime_methods',()=>work.promise);
  const submitted=f.session.submit();
  f.setContext({...current,anchor:{...anchor,editorRevision:9}});
  work.resolve({ok:true,receipt:{...target,run,releaseId},result:{methods:[{method:'take_damage',parameterTypes:['int'],returnType:'int',methodToken}],truncated:false}});
  await submitted;
  const discovery=last(f);
  assert.equal(discovery.draft.anchor.editorProjectId,'project-1');
  assert.deepEqual(discovery.resultFacts.sourceAnchor,anchor);
  f.session.loadPreset('engine.runtime_call','{"args":[25]}');
  f.session.updateTarget({sourceCallId:discovery.callId,methodName:'take_damage'});
  await f.session.submit();
  assert.equal(f.session.snapshot().clientError.kind,'stale_target');
  assert.equal(f.calls.length,1);

  f.setContext(current);
  await f.session.submit();
  assert.deepEqual(f.calls.at(-1).input,{op:'engine.runtime_call',input:{path:target.path,method:'take_damage',args:[25]}});
  assert.deepEqual(last(f).draft.selectedMethod.methodToken,methodToken);
  assert.deepEqual(last(f).draft.selectedMethod.parameterTypes,['int']);
  f.session.dispose();
});

test('loading historical parameters never invokes the API or rebinds an old Summer target',async()=>{
  const f=createConsoleFixture();f.session.selectOperation('engine.get_runtime_tree');await f.session.submit();const old=last(f);
  f.setContext(changeRun());f.session.loadHistory(old.callId);assert.equal(f.calls.length,1);assert.equal(f.session.snapshot().draft.anchor.activeRunId,'run-1');
  await f.session.submit();assert.equal(f.calls.length,1);assert.equal(f.session.snapshot().clientError.kind,'stale_target');f.session.dispose();
});

test('read target changes require descriptor types and never partially overwrite the draft',async()=>{
  const f=createConsoleFixture();f.session.selectOperation('engine.get_runtime_tree');await f.session.submit();const tree=last(f);
  f.session.selectOperation('read_runtime_properties');f.session.updateDraft('{"runId":"old-run","path":"/old","expectedInstanceId":"99","properties":[{"name":"old","expectedType":"string"}]}');
  const before=f.session.snapshot().draft;
  f.session.updateTarget({sourceCallId:tree.callId,nodePath:consoleNode.path});
  assert.equal(f.session.snapshot().clientError.kind,'missing_source');assert.deepEqual(f.session.snapshot().draft,before);
  f.session.updateDraft(JSON.stringify({runId:'run-1',path:consoleNode.path,expectedInstanceId:consoleNode.instanceId,properties:[{name:'health',expectedType:'int'}]}));
  f.session.updateTarget({sourceCallId:tree.callId,nodePath:consoleNode.path});assert.equal(f.session.snapshot().clientError,undefined);
  f.session.dispose();
});

test('unrelated results preserve both the draft input and its run binding',async()=>{
  const f=createConsoleFixture();f.session.selectOperation('engine.get_runtime_tree');await f.session.submit();const tree=last(f);
  f.session.selectOperation('engine.play');await f.session.submit();const play=last(f);
  f.setContext(changeRun());
  for(const op of ['engine.play','engine.stop','engine.screenshot','engine.get_project_context']){
    f.session.loadPreset(op,'{}');const draft=f.session.snapshot().draft;
    f.session.updateTarget({sourceCallId:tree.callId,nodePath:consoleNode.path});assert.deepEqual(f.session.snapshot().draft,draft);
    f.session.updateTarget({sourceCallId:play.callId});assert.deepEqual(f.session.snapshot().draft,draft);
  }f.session.dispose();
});

test('property fill preserves the entire draft above the SDK batch limit and accepts exactly 16',async()=>{
  const f=createConsoleFixture();const target={runId:'run-1',path:consoleNode.path,expectedInstanceId:consoleNode.instanceId};
  const descriptors=Array.from({length:17},(_,index)=>({name:`stat_${index}`,type:'int'}));
  f.setReply('describe_runtime_properties',{ok:true,receipt:{...target,run:consoleIdentity},result:{mode:'enumerate',properties:descriptors}});
  f.session.loadPreset('describe_runtime_properties',JSON.stringify(target));await f.session.submit();const sourceCallId=last(f).callId;
  f.setContext(changeRun());f.session.selectOperation('read_runtime_properties');
  const before=f.session.snapshot().draft;const propertyNames=descriptors.map(item=>item.name);
  f.session.updateTarget({sourceCallId,propertyNames});
  assert.deepEqual(f.session.snapshot().draft,before);assert.match(f.session.snapshot().clientError.message,/最多 16 项/);
  f.session.updateTarget({sourceCallId,propertyNames:propertyNames.slice(0,16)});
  assert.equal(f.session.snapshot().clientError,undefined);
  await f.session.submit();assert.deepEqual(f.calls.at(-1).input,{...target,properties:propertyNames.slice(0,16).map(name=>({name,expectedType:'int'}))});
  f.session.dispose();
});

test('PNG attachments are real Blobs with ArrayBuffer summaries, capped to four and released with history',async()=>{
  const f=createConsoleFixture();f.session.selectOperation('engine.screenshot');
  for(let index=0;index<5;index++)await f.session.submit();
  const history=f.session.snapshot().history;assert.equal(history[0].attachmentReleased,true);assert.equal(f.session.getAttachment(history[0].attachmentId),undefined);
  const attachment=f.session.getAttachment(history[4].attachmentId);assert(attachment.blob instanceof Blob);
  assert.equal(attachment.blob.size,consoleScreenshot().bytes.byteLength);assert.match(history[4].resultProjection,/ArrayBuffer/);
  assert.equal('bytes' in attachment.metadata,false);assert.equal(JSON.stringify(history).includes('"bytes":{}'),false);
  f.session.clearSettled();assert.equal(f.session.getAttachment(history[4].attachmentId),undefined);f.session.dispose();
});

test('single oversize image releases only the attachment and preserves successful screenshot metadata',async()=>{
  const f=createConsoleFixture();f.session.selectOperation('engine.screenshot');
  f.setReply('summer_call',{ok:true,result:{data:{...consoleScreenshot(),bytes:new ArrayBuffer(21*1024*1024)}}});
  await f.session.submit();assert.equal(last(f).phase,'settled');assert.equal(last(f).attachmentReleased,true);
  assert.match(last(f).summary,/PNG/);assert.match(last(f).resultProjection,/22020096/);f.session.dispose();
});

test('bounded projections keep provenance facts and history eviction invalidates fill sources',async()=>{
  const f=createConsoleFixture();f.session.selectOperation('engine.get_runtime_tree');
  f.setReply('summer_call',{ok:true,result:{data:{run:consoleIdentity,nodes:[consoleNode],padding:'界'.repeat(40000)}}});
  await f.session.submit();const first=last(f);assert.equal(first.truncated,true);assert(new TextEncoder().encode(first.resultProjection).length<=65536);
  assert.deepEqual(first.resultFacts.nodes[0],{path:consoleNode.path,instanceId:consoleNode.instanceId,type:'Node2D'});
  assert.equal(f.session.hasCall(first.callId),true);
  for(let index=0;index<20;index++)await f.session.submit();assert.equal(f.session.snapshot().history.length,20);
  assert.equal(f.session.hasCall(first.callId),false);
  f.session.selectOperation('describe_runtime_properties');f.session.updateTarget({sourceCallId:first.callId,nodePath:consoleNode.path});
  assert.equal(f.session.snapshot().clientError.kind,'missing_source');
  const newest=last(f).callId;assert.equal(f.session.hasCall(newest),true);
  f.session.clearSettled();assert.equal(f.session.hasCall(newest),false);f.session.dispose();
});

test('draft reformatting and result projection preserve signed zero and literal string keys and values',async()=>{
  const f=createConsoleFixture();
  const values={number:-0,values:['\0','\0\0','\\u0000',-0],'\0':'\0value','with"quote':'\0"value'};
  f.session.loadPreset('check',`{"number":-0,"values":["\\u0000","\\u0000\\u0000","\\\\u0000",-0],"\\u0000":"\\u0000value","with\\"quote":"\\u0000\\"value"}`);
  f.session.updateTarget();
  const {projectId,expectedEditorRevision,...draft}=JSON.parse(f.session.snapshot().draft.inputText);
  assert.equal(projectId,consoleEnvironment.anchor.editorProjectId);
  assert.equal(expectedEditorRevision,consoleEnvironment.anchor.editorRevision);
  assert.deepEqual(draft,values);
  f.setReply('check',{ok:true,result:values});
  await f.session.submit();
  assert.deepEqual(JSON.parse(last(f).resultProjection).result,values);
  f.session.dispose();
});

test('thrown calls and unconfirmed writes retain execution uncertainty, never retry',async()=>{
  const f=createConsoleFixture();f.session.selectOperation('engine.runtime_set');f.session.updateDraft('{}');
  f.setReply('summer_call',()=>{throw Error('transport lost');});await f.session.submit();assert.equal(last(f).phase,'thrown');assert.match(last(f).summary,/不代表未执行/);
  f.setReply('summer_call',{ok:false,error:{code:'outcome_unknown',message:'unknown'}});await f.session.submit();
  assert.match(last(f).summary,/不得自动重试/);assert.equal(f.calls.length,2);f.session.dispose();
});

test('dispose aborts outstanding requests, drops resources and suppresses late state delivery',async()=>{
  const f=createConsoleFixture(),work=deferred();f.session.selectOperation('wait_for_event');f.session.updateDraft('{"runId":"run-1","until":"running"}');
  f.setReply('wait_for_event',()=>work.promise);let events=0;f.session.subscribe(()=>events++);
  const running=f.session.submit();f.session.dispose();const before=events;assert.equal(f.calls[0].signal.aborted,true);
  work.resolve({ok:true,result:{outcome:'reached'}});await running;assert.equal(events,before);assert.equal(f.gate.owner(),null);
});

test('open example shares the replay/manual gate and never launches a game',async()=>{
  const f=createConsoleFixture(),token=f.gate.acquire('replay');await f.session.openExample();assert.equal(f.gate.owner(),'replay');
  f.gate.release(token);await f.session.openExample();assert.equal(f.gate.owner(),null);assert.equal(f.calls.length,0);f.session.dispose();
});

test('event cursor fill uses structured history and cancellation releases the console gate', async () => {
  const f = createConsoleFixture();
  try {
    f.setReply('summer_call', {ok: true, result: {data: {stream_id: 'page', next_seq: 3, events: [], truncated: true}}});
    f.session.selectOperation('engine.recent_events');
    await f.session.submit();
    const source = last(f);
    assert.equal(source.truncated, undefined);
    f.session.loadPreset('engine.wait_for_event', '{"kinds":["play.started"]}', false, true);
    await f.session.submit();
    assert.equal(f.session.snapshot().clientError.kind, 'missing_source');
    assert.equal(f.calls.length, 1);
    f.setContext(changeRun());
    f.session.updateTarget({sourceCallId: source.callId});
    assert.equal(f.calls.length, 1);
    assert.deepEqual(JSON.parse(f.session.snapshot().draft.inputText),
      {since: 3, stream_id: 'page', kinds: ['play.started']});
    f.setReply('summer_call', (_input, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ok: false, error: {code: 'cancelled'}}), {once: true});
    }));
    const waiting = f.session.submit();
    assert.equal(f.session.snapshot().owner, 'manual');
    f.session.cancel();
    await waiting;
    assert.equal(f.session.snapshot().owner, null);
    assert.match(last(f).summary, /cancelled/);
    f.session.clearSettled();
    f.session.updateTarget({sourceCallId: source.callId});
    assert.equal(f.session.snapshot().clientError.kind, 'missing_source');
    assert.equal(JSON.parse(f.session.snapshot().draft.inputText).since, 3);
  } finally {
    f.session.dispose();
  }
});

test('a display-truncated event result cannot advance the console cursor', async () => {
  const f = createConsoleFixture();
  try {
    const events = Array.from({length: 50}, (_, i) => ({
      seq: i + 1, kind: 'play.stopped', data: {run: consoleIdentity, detail: 'x'.repeat(1100)},
    }));
    f.setReply('summer_call', {ok: true, result: {data: {stream_id: 'page', since: 0, next_seq: 50, events}}});
    for (const [op, limit] of [['engine.recent_events', 'limit'], ['engine.wait_for_event', 'max_events']]) {
      f.session.loadPreset(op, '{}');
      await f.session.submit();
      const source = last(f);
      assert.equal(source.truncated, true);
      assert.match(source.summary, new RegExp(`since.*${limit}`));
      f.session.updateTarget({sourceCallId: source.callId});
      assert.equal(f.session.snapshot().clientError.kind, 'missing_source');
      assert.equal(f.session.snapshot().draft.inputText, '{}');
    }
  } finally {
    f.session.dispose();
  }
});

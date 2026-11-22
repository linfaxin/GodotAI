import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {getEngineProfile} from '../../../scripts/release/engine-profiles.mjs';
import {createDebugRecorder} from '../src/debug-api.ts';

// Execute the production preparation and selection functions, with only DOM,
// persistence and the asynchronous preview constructor replaced by small ports.
const source=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('function select(demo:Demo,'),source.indexOf('function fileForm('))+'\n'+source.slice(source.indexOf('async function prepareRuntime(run:boolean){'),source.indexOf('async function start(){'));
const javascript=ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function fixture(){
 let resolvePreview;const pending=new Promise(resolve=>{resolvePreview=resolve;}),nodes=new Map(),compiles=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,setAttribute(name){if(name==='disabled')this.disabled=true;},removeAttribute(name){if(name==='disabled')this.disabled=false;},replaceChildren(){},querySelector(){return this;}});return nodes.get(id);};
 const project={engineProfile:'engine-2d-v1',runtime:'react',entry:'/App.tsx',selected:'/App.tsx',files:{'/App.tsx':'export default function App(){return null;}'},mode:'production'};
 const captured={};
 const context={shellOnly:false,current:project,siteEngineProfile:'engine-2d-v1',runtimeSerial:0,ready:false,nativePreview:undefined,nativePreviewPending:undefined,
  $:node,workbench:{setReady(){},resetTabs(){}},editor:{reset(){}},explorer:{reset(){}},status(){},toast(){},onEngineEvent(){},createEnginePreview:()=>pending,compile:()=>compiles.push('compile'),
  debugRecorder:{setContext(value){Object.assign(captured,value);},recordRunEvent(){}},debugFailure(){},debugRelease(){return {};},
  protectedProjectIds:new Set(),projects:new Map(),projectEvents:[],activeEngineRevision:-1,clearTimeout,checkTimer:undefined,runSerial:0,checking:0,revision:0,selected:undefined,storage:{stage(){}},
  initialProject:()=>project,setDiagnostics(){},selectFile(){},controls(){},invalidatePlay(){},save:async()=>{},document:{querySelectorAll:()=>[]},Option:class{},getEngineProfile};
 vm.createContext(context);vm.runInContext(javascript,context);
 return {context,node,compiles,captured,prepare:run=>vm.runInContext(`prepareRuntime(${run})`,context),select:profile=>{const demo={id:'retained',name:'Retained',controls:[]};context.projects.set(demo.id,{...project,engineProfile:profile});context.demo=demo;return vm.runInContext('select(demo)',context);},resolve:()=>resolvePreview({stop:async()=>{},runner:{state:'idle'},configuration:{executionBackend:'worker',presentationBackend:'direct'}})};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('late preview preparation cannot enable or run an unsupported project selected while loading',async()=>{
 const f=fixture(),old=f.prepare(true);await tick();f.select('future-engine-v9');
 assert.equal(f.context.ready,false);assert.equal(f.node('run').disabled,true);
 f.resolve();await old;
 assert.equal(f.context.ready,false);assert.equal(f.node('run').disabled,true);assert.equal(f.node('check').disabled,true);assert.deepEqual(f.compiles,[]);
 assert.equal(f.captured.preview.status,'unsupported');assert.equal(f.captured.projectId,'retained');
});

test('shell-only and unsupported early returns cancel older pending preparation',async()=>{
 for(const kind of ['shell','unsupported']){
  const f=fixture(),old=f.prepare(true);await tick();
  if(kind==='shell')f.context.shellOnly=true;else f.context.current={...f.context.current,engineProfile:'future-engine-v9'};
  await f.prepare(false);f.resolve();await old;
  assert.equal(f.context.ready,false,kind);assert.equal(f.node('run').disabled,true,kind);assert.deepEqual(f.compiles,[],kind);
  assert.equal(f.captured.preview.status,'unsupported');
 }
});

test('the latest compatible preparation remains usable after superseding an older request',async()=>{
 const f=fixture(),old=f.prepare(true);await tick();const latest=f.prepare(false);await tick();f.resolve();await Promise.all([old,latest]);
 assert.equal(f.context.ready,true);assert.equal(f.node('run').disabled,false);assert.deepEqual(f.compiles,[]);
 assert.equal(f.captured.preview.status,'available');
});

function buildFixture(state='running'){
 const recorder=createDebugRecorder(), requests=[], preparations=[],stoppedRuns=[];
 const configuration={executionBackend:'worker',presentationBackend:'direct'};
 recorder.setContext({projectId:'project',editorRevision:1,preview:{status:'available',value:configuration}});
 const deferred=()=>{let resolve,reject;const promise=new Promise((accept,deny)=>{resolve=accept;reject=deny;});return {promise,resolve,reject};};
 const nodes=new Map();
 const node=id=>{
  if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false,setAttribute(){this.disabled=true;},toggleAttribute(_name,value){this.disabled=value;}});
  return nodes.get(id);
 };
 const context={
  AbortController,DOMException,Uint8Array,debugRecorder:recorder,clearTimeout,setTimeout:()=>0,checkTimer:undefined,saveTimer:undefined,
  ready:true,current:{engineProfile:'full-engine-v1'},siteEngineProfile:'full-engine-v1',selected:{id:'project',name:'Project'},
  MAX_PENDING_OPERATIONS:16,pendingBuilds:0,playIntent:undefined,runSerial:0,revision:1,checking:0,
  cancelledLaunches:new Map(),reconcilingCancelledLaunches:false,
  persistenceBlocked:false,storage:{stage(){}},sessionReleaseContext:{},diagnostics:[],setDiagnostics(){},log(){},assertCompiledRelease(){},
  status(text,kind){Object.assign(node('status'),{textContent:text,kind});},
  applyCompiledImportReceipts:()=>false,debugRelease:()=>({}),workbench:{setBuilding(){node('stop').disabled=false;},setReady(){}},
  $:node,
  nativePreview:{configuration,runner:{state},stop:async()=>{},stopRun(runId){stoppedRuns.push(runId);return Promise.resolve();},run(...args){
   const preparation=deferred();
   const signal=args[5];
   preparations.push(signal);
   signal.addEventListener('abort',()=>preparation.reject(new DOMException('Superseded','AbortError')),{once:true});
   return preparation.promise;
  }},
  rpc(){const request=deferred();requests.push(request);return request.promise;},
 };
 const compile=source.slice(source.indexOf('const buildStatus='),source.indexOf('function controls('));
 const invalidate=source.slice(source.indexOf('function invalidatePlay('),source.indexOf('function initialProject('));
 const cancellation=source.slice(source.indexOf('function cancelLaunch('),source.indexOf("addEventListener('pagehide'"));
 const toolbar=source.slice(source.indexOf("$('run').onclick="),source.indexOf("$<HTMLSelectElement>('mode').onchange="));
 const javascript=ts.transpileModule(cancellation+invalidate+compile+toolbar,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 vm.createContext(context);vm.runInContext(javascript,context);
 recorder.subscribe(()=>vm.runInContext('reconcileCancelledLaunches()',context));
 const variant='single-pack',manifest={variant,buildKey:'a'.repeat(64),artifactId:'b'.repeat(64)};
 const compileReply={variant,manifest,pack:new Uint8Array([1]),diagnostics:[]};
 return {context,node,recorder,requests,preparations,compileReply,stoppedRuns,
  cancel:attemptId=>{context.cancelTarget=attemptId;vm.runInContext('cancelLaunch(cancelTarget)',context);},
  compile:()=>vm.runInContext('compile()',context),edit:()=>vm.runInContext('changed()',context)};
}

test('accepting a new build aborts the old preview preparation before the new compiler reply',async()=>{
 const {compile,node,recorder,requests,preparations,compileReply}=buildFixture();
 const first=compile();
 requests[0].resolve(compileReply);
 await tick();
 assert.equal(preparations.length,1);
 const next=compile();
 await tick();
 assert.notEqual(first,next);
 assert.equal(preparations[0].aborted,true);
 assert.equal(node('status').textContent,'正在检查 TypeScript');
 assert.equal(recorder.api.getBuild(next).result.status,'pending');
 requests[1].resolve({diagnostics:[{category:'error',code:2322,message:'invalid'}]});
 await tick();
 assert.equal(recorder.api.getBuild(first).result.preview.status,'skipped');
 assert.equal(recorder.api.getBuild(next).result.status,'failed');
 assert.equal(preparations.length,1);
});

test('editing during preview preparation restores the actual phase and keeps a newer runtime error',async()=>{
 for(const [phase,message,stopDisabled] of [['running','实时运行中',false],['idle','等待运行',true],['exited','运行错误',true]]){
  const {compile,edit,context,node,recorder,requests,compileReply}=buildFixture(phase);
  const attemptId=compile();
  requests[0].resolve(compileReply);
  await tick();
  if(phase==='exited'){
   context.status('运行错误','error');
   node('stop').disabled=true;
  }
  edit();
  await tick();
  assert.equal(recorder.api.getBuild(attemptId).result.preview.status,'skipped');
  assert.equal(node('status').textContent,message);
  assert.equal(node('stop').disabled,stopDisabled);
  assert.equal(node('run').disabled,false);
 }
});

test('toolbar stop restores the idle status while a build is still pending',async()=>{
 const {compile,node,recorder,requests,compileReply}=buildFixture('idle');
 const attemptId=compile();
 node('stop').onclick();
 assert.equal(node('status').textContent,'等待运行');
 assert.equal(node('stop').disabled,true);
 requests[0].resolve(compileReply);
 await tick();
 assert.equal(recorder.api.getBuild(attemptId).result.preview.status,'skipped');
});

test('cancelled attempt retains a late-session stop obligation without targeting a later run',async()=>{
 const f=buildFixture();
 const attempt=f.compile();f.requests[0].resolve(f.compileReply);await tick();
 f.cancel(attempt);
 assert.equal(f.preparations[0].aborted,true);
 assert(f.context.cancelledLaunches.has(attempt));
 const later=f.compile();
 const release={releaseId:'a'.repeat(64),engineProfile:'full-engine-v1',descriptorSha256:'b'.repeat(64)};
 const configuration={executionBackend:'worker',presentationBackend:'direct'};
 const make=(runId,generation)=>({runId,generation,revision:1,buildKey:'a'.repeat(64),documentId:'doc-'+runId,workerId:'worker-'+runId,runConfigurationHash:'c'.repeat(64)});
 const newer=make('newer-run',2),older=make('cancelled-late-run',1);
 const oldRegistration=f.recorder.registerPreview(attempt,{generation:1,release,configuration});
 f.recorder.recordRunEvent({...older,type:'state',state:'loading-frame'});
 oldRegistration();
 await tick();
 assert.deepEqual(f.stoppedRuns,['cancelled-late-run']);
 f.recorder.recordRunEvent({type:'exit',report:{...older,reason:'clean-exit',code:0}});
 await tick();
 assert(!f.context.cancelledLaunches.has(attempt));
 f.requests[1].resolve(f.compileReply);await tick();
 const newerRegistration=f.recorder.registerPreview(later,{generation:2,release,configuration});
 f.recorder.recordRunEvent({...newer,type:'state',state:'loading-frame'});
 f.recorder.recordRunEvent({...newer,type:'state',state:'running'});
 newerRegistration();
 await tick();
 assert.equal(f.recorder.api.getRun(newer.runId).result.state,'running');
 assert.deepEqual(f.stoppedRuns,['cancelled-late-run']);
 f.cancel(later);await tick();
});

/** Real pthread clone rejection, original rawWorker, final-message and batch transfer proof. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {packProject} from '../../packages/project-tools/dist/pck.js';
import {resolveBrowserExecutable} from './browser-launch.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(path.join(root,'apps/playground/package.json'));
const {chromium}=require('playwright'),{build}=require('esbuild'),ts=require('typescript');
const option=(name,fallback)=>{const at=process.argv.indexOf(name);return at<0?fallback:process.argv[at+1];};
const reportPath=path.resolve(option('--report','work/architecture-implementation/web-2d-proxy-report.json'));
const directory=path.resolve(option('--out','work/architecture-implementation/web-worker-transfer'));
const rounds=Number(option('--rounds','100')),batch=Number(option('--batch','64'));
assert(Number.isInteger(rounds)&&rounds>0&&rounds<=1000&&Number.isInteger(batch)&&batch>0&&batch<=2048);
const reportBytes=await readFile(reportPath),engineReport=JSON.parse(reportBytes);
assert.equal(engineReport.status,'built');assert.equal(engineReport.execution.executionModel,'proxy-pthread');
const template=path.resolve(path.dirname(reportPath),engineReport.template.path),archive=await readFile(template);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');assert.equal(hash(archive),engineReport.template.sha256);
await mkdir(directory,{recursive:true});const served=path.join(directory,'template');await mkdir(served,{recursive:true});
execFileSync(process.env.PYTHON??'python3',['-m','zipfile','-e',template,served]);
const encode=value=>new TextEncoder().encode(value),files=new Map(),sourceHashes={};
const put=(uri,bytes)=>files.set(uri,typeof bytes==='string'?encode(bytes):bytes);
for(const file of ['tests/worker/test-worker.ts','tests/worker/test.worker.ts','tests/worker/transfer-scripted-node.ts','tests/worker/messaging.ts','tests/test-status.ts','tests/resource/player-resource.ts']){
 const bytes=await readFile(path.join(root,'tests/project',file)),source=bytes.toString();sourceHashes[file]=hash(bytes);put('res://'+file,bytes);
 put('res://.godot/GodotJS/'+file.replace(/\.ts$/,'.js'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText);
}
for(const file of ['tests/resource/mage.tres','tests/resource/warrior.tres']){
 const bytes=await readFile(path.join(root,'tests/project',file));sourceHashes[file]=hash(bytes);put('res://'+file,bytes);
}
const closeFixture=require(path.join(root,'scripts/test/fixtures/worker-close-probe.cjs'));
const closeFixtureBytes=await readFile(path.join(root,'scripts/test/fixtures/worker-close-probe.cjs'));sourceHashes['worker-close-probe.cjs']=hash(closeFixtureBytes);
put('res://worker-close-probe.js',closeFixtureBytes);
for(const [name,source]of [['p1-close-startup',closeFixture.startupSource],['p1-close-message',closeFixture.messageSource]]){
 put('res://src/'+name+'.worker.js',source);put('res://.godot/GodotJS/src/'+name+'.worker.js',source);
}
const stress=`const G=require('godot'),{JSWorkerParent}=require('godot.worker'),T=require('../tests/worker/transfer-scripted-node').default;
JSWorkerParent.onmessage=data=>{try{
 if(data.kind!=='batch')throw Error('unexpected stress message');
 for(const node of data.nodes){if(!(node instanceof T)||node.exportInt!==data.round||!node.get_script())throw Error('receiver script binding lost');node.exportInt=data.round+1;}
 let childCloneError;
 if(data.round===0){try{JSWorkerParent.postMessage({node:data.nodes[0],bad(){throw Error('must not call');}},[data.nodes[0]]);}catch(error){childCloneError=error.name;}if(childCloneError!=='DataCloneError'||!data.nodes[0].get_script())throw Error('child clone rejection changed source binding: '+childCloneError);}
 JSWorkerParent.postMessage({kind:'batch',round:data.round,nodes:data.nodes,childCloneError},data.nodes);
 if(data.round===${rounds-1})JSWorkerParent.close();
}catch(error){JSWorkerParent.postMessage({kind:'failure',error:String(error),stack:error.stack});}};`;
put('res://src/stress.worker.js',stress);put('res://.godot/GodotJS/src/stress.worker.js',stress);
const source=`const G=require('godot'),{JSWorker}=require('godot.worker'),S=require('../tests/test-status'),T=require('../tests/worker/transfer-scripted-node').default;
const event=(type,data={})=>console.log('WEB_WORKER_TRANSFER '+JSON.stringify({type,...data}));
const check=(value,label)=>{if(!value)throw Error('E_WEB_WORKER_TRANSFER '+label);};
exports.default=class Probe extends G.Node{
 _ready(){this.frames=0;this.phase='raw';this.completed=0;event('started',{rounds:${rounds},batch:${batch}});}
 fail(error){event('failure',{error:String(error),stack:error?.stack});this.get_tree().quit(1);}
 _process(){try{
  if(++this.frames>18000)throw Error('frame deadline '+this.phase);
  if(this.phase==='raw'&&!S.hasActiveAsyncTests()){
   check(!S.hasTestFailure(),'original rawWorker tests failed');event('raw-worker-complete');this.phase='p1';this.closeProbe=require('res://worker-close-probe.js').run(G);
  }
  if(this.phase==='p1'){
   this.closeProbe.process();const status=this.closeProbe.results();if(status.done){check(status.passed,JSON.stringify(status));event('p1-complete',status);this.closeProbe.dispose();this.phase='stress';this.stress=new JSWorker('src/stress.worker');this.stress.onready=()=>this.sendBatch(0);this.stress.onmessage=data=>this.receiveBatch(data);}
  }
 }catch(error){this.fail(error);}}
 sendBatch(round){try{
  const nodes=Array.from({length:${batch}},()=>{const node=new T();node.exportInt=round;node.exportText='round-'+round;return node;});
  if(round===0){
   let cloneError;try{this.stress.postMessage({node:nodes[0],bad(){}},[nodes[0]]);}catch(error){cloneError=error.name;}
   const sourceStillBound=G.is_instance_valid(nodes[0])&&!!nodes[0].get_script();event('clone-rejection-observed',{cloneError,sourceStillBound});check(cloneError==='DataCloneError'&&sourceStillBound,'parent clone rejection preserves source script');event('clone-rejection-complete');
   const first=new T(),second=new T();let freed=false,invalidRejected=false;
   const invalid={first,second,get invalidate(){if(!freed){freed=true;second.free();}return 1;}};
   try{this.stress.postMessage(invalid,[first,second]);}catch(error){invalidRejected=true;}
   check(invalidRejected&&freed&&G.is_instance_valid(first)&&!!first.get_script(),'batch prevalidation must preserve first source binding');first.free();event('batch-rejection-complete');
  }
  this.stress.postMessage({kind:'batch',round,nodes},nodes);
 }catch(error){this.fail(error);}}
 receiveBatch(data){try{
  check(data.kind==='batch',JSON.stringify(data));check(data.round===this.completed,'batch order');check(data.nodes.length===${batch},'batch cardinality');
  if(data.round===0){check(data.childCloneError==='DataCloneError','child original clone error');event('child-clone-rejection-complete',{cloneError:data.childCloneError});}
  for(const node of data.nodes){check(G.is_instance_valid(node)&&node instanceof T&&node.exportInt===data.round+1&&!!node.get_script(),'returned script binding');node.free();}
  this.completed++;if(this.completed<${rounds})this.sendBatch(this.completed);else{event('stress-complete',{rounds:this.completed,batch:${batch},scriptedTransfers:this.completed*${batch}*2});this.phase='complete';this.get_tree().quit(0);}
 }catch(error){this.fail(error);}}
};`;
put('res://project.godot','config_version=5\n[application]\nrun/main_scene="res://Probe.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\n');
put('res://Probe.tscn','[gd_scene load_steps=3 format=3]\n[ext_resource type="Script" path="res://src/Probe.ts" id="1"]\n[ext_resource type="Script" path="res://tests/worker/test-worker.ts" id="2"]\n[node name="TransferProbe" type="Node"]\nscript=ExtResource("1")\n[node name="OriginalRawWorker" type="Node" parent="."]\nscript=ExtResource("2")\n');
put('res://src/Probe.ts','export default class Probe {}\n');put('res://.godot/GodotJS/src/Probe.js',source);
put('res://.godot/global_script_class_cache.cfg','list=Array[Dictionary]([])\n');
const pack=packProject(files).pack;await writeFile(path.join(served,'probe.pck'),pack);
const sdk=(await build({stdin:{contents:'export {BrowserEngineSession} from "./packages/engine/src/browser/engine-session.ts";',resolveDir:root},bundle:true,format:'iife',globalName:'ProbeSDK',platform:'browser',target:'es2022',write:false})).outputFiles[0].contents;
await writeFile(path.join(served,'probe-sdk.js'),sdk);
await writeFile(path.join(served,'index.html'),`<!doctype html><canvas id="canvas" width="64" height="64"></canvas><script src="probe-sdk.js"></script><script src="godot.js"></script><script>
globalThis.probe={logs:[],errors:[],summaries:[],done:false,exitCode:null};
// The test owner delays only P1 final packets; project scheduling is unchanged.
const ownerSetTimeout=globalThis.setTimeout.bind(globalThis),postWorker=Worker.prototype.postMessage;
Worker.prototype.postMessage=function(message,...args){if(message?.__jsbMessage&&message.route?.direction==='to-parent'&&message.data?.kind==='p1-close-final'){ownerSetTimeout(()=>postWorker.call(this,message,...args),300);return;}return postWorker.call(this,message,...args);};
const session=new ProbeSDK.BrowserEngineSession({identity:{runId:'web-worker-transfer',revision:1,generation:'probe',buildKey:'probe'},executionModel:'proxy-pthread',requiresCrossOriginIsolation:true,hostResourceAbi:${JSON.stringify(engineReport.execution.hostResourceAbi)},onDiagnostic:item=>{probe.errors.push(item.message);probe.done=true;},onLog:(level,text)=>probe.logs.push(text),onSummary:summary=>probe.summaries.push(summary)});
(async()=>{const engine=new Engine({canvas:document.querySelector('canvas'),executable:'godot',emscriptenPoolSize:3,persistentPaths:[],focusCanvas:false,onPrint:(...args)=>probe.logs.push(args.join(' ')),onPrintError:(...args)=>probe.logs.push(args.join(' ')),onExit:code=>{probe.exitCode=code;probe.done=true;}});session.installResourceOwner(engine);await engine.preloadFile('probe.pck','/probe.pck');await engine.init('godot');session.attachEngine(engine);await engine.start({args:['--main-pack','/probe.pck','--rendering-method','gl_compatibility','--audio-driver','Dummy']});})().catch(error=>{probe.errors.push(String(error));probe.done=true;});
globalThis.cleanupProbe=async()=>{await session.waitForRuntimeSummary(1500);const facts=session.sessionFacts({...(probe.exitCode!==null?{nativeExit:{code:probe.exitCode}}:{})}),stats=session.getStats(),cleanup=await session.dispose(probe.exitCode===0?'clean':'force');return {facts:{...facts,hostCleanup:cleanup.status},stats,cleanup};};
</script>`);
const server=createServer(async(req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname),file=path.resolve(served,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(served+path.sep)){res.writeHead(403).end();return;}try{const bytes=await readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.wasm')?'application/wasm':file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}).end(bytes);}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,page,progressTimer;const consoleLogs=[],pageErrors=[];
const result={schemaVersion:1,kind:'godotjs-actual-web-worker-transfer',status:'failed',engineReport:reportPath,engineReportSha256:hash(reportBytes),templateSha256:engineReport.template.sha256,sdkBundleSha256:hash(sdk),packSha256:hash(pack),harnessSha256:hash(await readFile(fileURLToPath(import.meta.url))),sourceHashes,rounds,batch};
try{
 const selected=resolveBrowserExecutable(chromium,'chromium');result.browserSource=selected.source;
 browser=await chromium.launch({headless:true,executablePath:selected.executablePath,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});page=await browser.newPage();
 page.on('console',message=>{consoleLogs.push(message.text());if(message.text().includes('WEB_WORKER_TRANSFER '))process.stdout.write(message.text()+'\n');});page.on('pageerror',error=>pageErrors.push(String(error)));
 await page.goto('http://127.0.0.1:'+server.address().port);
 progressTimer=setInterval(()=>{void page.evaluate(()=>({done:probe.done,exitCode:probe.exitCode,errors:probe.errors,logs:probe.logs.slice(-12)})).then(progress=>{process.stdout.write('WEB_WORKER_TRANSFER_PROGRESS '+JSON.stringify(progress)+'\n');return writeFile(path.join(directory,'progress.json'),JSON.stringify(progress,null,2)+'\n');}).catch(()=>{});},15000);
 await page.waitForFunction(()=>probe.done,null,{timeout:300000});
 result.observed=await page.evaluate(async()=>({...probe,...await cleanupProbe()}));result.pageErrors=pageErrors;
 const events=[...result.observed.logs,...consoleLogs].filter(text=>text.startsWith('WEB_WORKER_TRANSFER ')).map(text=>JSON.parse(text.slice('WEB_WORKER_TRANSFER '.length)));result.events=events;
 assert.equal(result.observed.exitCode,0);assert.deepEqual(result.observed.errors,[]);assert.deepEqual(pageErrors,[]);assert(!events.some(e=>e.type==='failure'));
 for(const type of ['raw-worker-complete','p1-complete','clone-rejection-complete','child-clone-rejection-complete','batch-rejection-complete','stress-complete'])assert(events.some(e=>e.type===type),type);
 assert.deepEqual(result.observed.logs.filter(text=>/^(?:ERROR:|\[ERROR\])/.test(text)),[],'native transfer shutdown must have no hidden errors');assert.equal(result.observed.cleanup.status,'complete');result.status='passed';
}catch(error){result.error=String(error);result.consoleLogs=consoleLogs;result.pageErrors=pageErrors;try{result.observed??=await page?.evaluate(()=>probe);}catch{}process.exitCode=1;}finally{clearInterval(progressTimer);await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
await writeFile(path.join(directory,'report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));

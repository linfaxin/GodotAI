/** Fresh scripted resources loaded by Godot's native background task pool. */
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
const reportPath=path.resolve(option('--report','work/architecture-implementation/web-2d-report.json'));
const directory=path.resolve(option('--out','work/architecture-implementation/web-threaded-shadow'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),reportBytes=await readFile(reportPath),engineReport=JSON.parse(reportBytes);
assert.equal(engineReport.status,'built');assert.equal(engineReport.sourceCertified,true);
const archive=path.resolve(path.dirname(reportPath),engineReport.template.path);assert.equal(hash(await readFile(archive)),engineReport.template.sha256);
await mkdir(directory,{recursive:true});const served=path.join(directory,'template');await mkdir(served,{recursive:true});
execFileSync(process.env.PYTHON??'python3',['-m','zipfile','-e',archive,served]);
const files=new Map(),encode=text=>new TextEncoder().encode(text),sources={};
const put=(uri,text)=>files.set(uri,typeof text==='string'?encode(text):text);
for(const [index,name]of ['A','B'].entries()){
 const source=`import {Resource,Variant} from 'godot';import {createClassBinder} from 'godot.annotations';const bind=createClassBinder();@bind() export default class ThreadedShadow${name} extends Resource{@bind.export(Variant.Type.TYPE_INT) accessor shadow_value:number=7;}`;
 sources[name]=hash(encode(source));put(`res://src/ThreadedShadow${name}.ts`,source);
 put(`res://.godot/GodotJS/src/ThreadedShadow${name}.js`,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText);
 put(`res://Shadow${name}.tres`,`[gd_resource type="Resource" load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/ThreadedShadow${name}.ts" id="1"]\n[resource]\nscript=ExtResource("1")\nresource_name="ThreadedShadow${name}"\nshadow_value=${51+index}\n`);
}
const source=`const G=require('godot');const event=(type,data={})=>console.log('WEB_THREADED_SHADOW '+JSON.stringify({type,...data}));
const check=(value,label)=>{if(!value)throw Error('E_THREADED_SHADOW '+label);};
exports.default=class Probe extends G.Node{
 _ready(){this.index=0;this.frames=0;this.resources=[];this.request();}
 request(){this.path='res://Shadow'+['A','B'][this.index]+'.tres';check(G.ResourceLoader.load_threaded_request(this.path,'Resource',false)===0,'threaded request');event('requested',{path:this.path});}
 _process(){try{
  if(++this.frames>1800)throw Error('threaded metadata deadline');
  const state=G.ResourceLoader.load_threaded_get_status(this.path);
  if(state===G.ResourceLoader.ThreadLoadStatus.THREAD_LOAD_FAILED)throw Error('background loader failed');
  if(state!==G.ResourceLoader.ThreadLoadStatus.THREAD_LOAD_LOADED)return;
  const resource=G.ResourceLoader.load_threaded_get(this.path),expected=51+this.index;
  check(resource&&resource.get('shadow_value')===expected,'exported value survives owner metadata VM retirement');
  check(resource.get('resource_name')==='ThreadedShadow'+['A','B'][this.index],'native resource identity');
  check(resource.get('script'),'script metadata remains associated');this.resources.push(resource);
  event('loaded',{path:this.path,value:expected});if(++this.index<2)this.request();else{event('complete',{resources:2});this.get_tree().quit(0);}
 }catch(error){event('failure',{error:String(error),stack:error.stack});this.get_tree().quit(1);}}
};`;
put('res://project.godot','config_version=5\n[application]\nrun/main_scene="res://Probe.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\n');
put('res://Probe.tscn','[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/Probe.ts" id="1"]\n[node name="ThreadedShadowProbe" type="Node"]\nscript=ExtResource("1")\n');
put('res://src/Probe.ts','export default class Probe {}\n');put('res://.godot/GodotJS/src/Probe.js',source);
put('res://.godot/global_script_class_cache.cfg','list=Array[Dictionary]([])\n');
const pack=packProject(files).pack;await writeFile(path.join(served,'probe.pck'),pack);
const sdk=(await build({stdin:{contents:'export {BrowserEngineSession} from "./packages/engine/src/browser/engine-session.ts";',resolveDir:root},bundle:true,format:'iife',globalName:'ProbeSDK',platform:'browser',target:'es2022',write:false})).outputFiles[0].contents;
await writeFile(path.join(served,'probe-sdk.js'),sdk);
await writeFile(path.join(served,'index.html'),`<!doctype html><canvas id="canvas" width="64" height="64"></canvas><script src="probe-sdk.js"></script><script src="godot.js"></script><script>
globalThis.probe={logs:[],errors:[],summaries:[],done:false,exitCode:null};
const session=new ProbeSDK.BrowserEngineSession({identity:{runId:'threaded-shadow',revision:1,generation:'probe',buildKey:'probe'},executionModel:${JSON.stringify(engineReport.execution.executionModel)},requiresCrossOriginIsolation:${!!engineReport.execution.requiresCrossOriginIsolation},hostResourceAbi:${JSON.stringify(engineReport.execution.hostResourceAbi)},onDiagnostic:item=>{probe.errors.push(item.message);probe.done=true;},onLog:(level,text)=>probe.logs.push(text),onSummary:summary=>probe.summaries.push(summary)});
(async()=>{const engine=new Engine({canvas:document.querySelector('canvas'),executable:'godot',emscriptenPoolSize:3,persistentPaths:[],focusCanvas:false,onPrint:(...args)=>probe.logs.push(args.join(' ')),onPrintError:(...args)=>probe.logs.push(args.join(' ')),onExit:code=>{probe.exitCode=code;probe.done=true;}});session.installResourceOwner(engine);await engine.preloadFile('probe.pck','/probe.pck');await engine.init('godot');session.attachEngine(engine);await engine.start({args:['--main-pack','/probe.pck','--rendering-method','gl_compatibility','--audio-driver','Dummy']});})().catch(error=>{probe.errors.push(String(error));probe.done=true;});
globalThis.cleanupProbe=async()=>{await session.waitForRuntimeSummary(1500);const facts=session.sessionFacts({...(probe.exitCode!==null?{nativeExit:{code:probe.exitCode}}:{})}),stats=session.getStats(),cleanup=await session.dispose(probe.exitCode===0?'clean':'force');return {facts:{...facts,hostCleanup:cleanup.status},stats,cleanup};};
</script>`);
const server=createServer(async(req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname),file=path.resolve(served,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(served+path.sep)){res.writeHead(403).end();return;}try{const bytes=await readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.wasm')?'application/wasm':file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}).end(bytes);}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,page;const consoleLogs=[],pageErrors=[];
const result={schemaVersion:1,kind:'godotjs-actual-threaded-shadow-owner',status:'failed',engineReport:reportPath,engineReportSha256:hash(reportBytes),templateSha256:engineReport.template.sha256,sdkBundleSha256:hash(sdk),packSha256:hash(pack),harnessSha256:hash(await readFile(fileURLToPath(import.meta.url))),sources};
try{
 const selected=resolveBrowserExecutable(chromium,'chromium');result.browserSource=selected.source;
 browser=await chromium.launch({headless:true,executablePath:selected.executablePath,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});page=await browser.newPage();
 page.on('console',message=>consoleLogs.push(message.text()));page.on('pageerror',error=>pageErrors.push(String(error)));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>probe.done,null,{timeout:150000});
 result.observed=await page.evaluate(async()=>({...probe,...await cleanupProbe()}));result.pageErrors=pageErrors;
 result.events=[...result.observed.logs,...consoleLogs].filter(text=>text.startsWith('WEB_THREADED_SHADOW ')).map(text=>JSON.parse(text.slice('WEB_THREADED_SHADOW '.length)));
 const consoleCreations=consoleLogs.filter(text=>text.includes('creating a shadow Environment on thread'));
 const nativeCreations=result.observed.logs.filter(text=>text.includes('creating a shadow Environment on thread'));
 // The two sources can observe the same log. A retired Environment address
 // can also be reused, so identical creation lines must remain countable.
 result.shadowCreationLogs=consoleCreations.length>=nativeCreations.length?consoleCreations:nativeCreations;
 assert.equal(result.observed.exitCode,0);assert.deepEqual(result.observed.errors,[]);assert.deepEqual(pageErrors,[]);
 assert.equal(new Set(result.events.filter(e=>e.type==='loaded').map(e=>e.path)).size,2);assert(result.events.some(e=>e.type==='complete'));
 assert(result.shadowCreationLogs.length>=2,'both fresh Script classes must execute metadata in a background Shadow VM');
 assert(!result.events.some(e=>e.type==='failure'));assert.deepEqual(result.observed.logs.filter(text=>/^(?:ERROR:|\[ERROR\])/.test(text)),[]);assert.equal(result.observed.cleanup.status,'complete');result.status='passed';
}catch(error){result.error=String(error);result.consoleLogs=consoleLogs;result.pageErrors=pageErrors;try{result.observed??=await page?.evaluate(()=>probe);}catch{}process.exitCode=1;}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
await writeFile(path.join(directory,'report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));

import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildProject,exportProject,assertCleanExecution,loadConfig,watchProject} from '../../../scripts/jsb.react-build/dist/index.js';
import {command} from '../../../scripts/jsb.react-build/dist/fs.js';
import {readBusinessVerification} from '../../../scripts/jsb.react-build/dist/commands.js';
import {activeRunLeases,processAlive} from '../../../scripts/jsb.react-build/dist/publication.js';
import {captureNativeCertificate,assertNativeCertificate,isolateGodotEditor,assertNoInspectorTransportErrors,sdkFingerprint} from '../../react_fixture_evidence.mjs';

const [binary,output]=process.argv.slice(2);
if(!binary||!output)throw Error('Usage: node tests/react/review-regressions/run.mjs /absolute/godot /independent/output');
const work=path.resolve(output),fixture=path.dirname(fileURLToPath(import.meta.url));
await fs.mkdir(work,{recursive:true});
const nativeCertificate=await captureNativeCertificate(binary),sdkSourceHash=await sdkFingerprint(),editorIsolation=await isolateGodotEditor();
const runs=[];
async function copyProject(target){
  await fs.mkdir(target,{recursive:true});
  for(const file of ['project.godot','godot-react.config.mjs','tsconfig.json','src'])await fs.cp(path.join(fixture,file),path.join(target,file),{recursive:true});
  await fs.writeFile(path.join(target,'package.json'),'{}');
}
async function execute(target,args,label,expected){
  const result=await command(path.resolve(binary),args,{cwd:target,timeoutMs:45000});
  await fs.writeFile(path.join(work,`${label}.log`),result.stdout+result.stderr);
  assertNoInspectorTransportErrors(result.stdout+result.stderr);
  const boot=assertCleanExecution(result,expected);
  const business=readBusinessVerification(result.stdout,expected);
  if(Object.values(business.result).some(value=>value!==true&&value!=='production-silent'))throw Error(`Failed ${label} behavior: ${JSON.stringify(business.result)}`);
  return {boot,business};
}
const project=path.join(work,'project');await copyProject(project);
for(const mode of ['production','development']){
  const built=await buildProject({projectRoot:project,godot:path.resolve(binary),mode});
  const result=await execute(project,['--headless','--path',project,built.manifest.entries.app.scene,'--','--godot-react-business-verify'],`source-${mode}`,{generation:built.generation,entryId:'app'});
  runs.push({mode,kind:'source',generation:built.generation,...result});
}
const exported=await exportProject({projectRoot:project,godot:path.resolve(binary),output:'review-regressions.pck'});
const empty=path.join(work,'empty');await fs.mkdir(empty,{recursive:true});
const packed=await execute(empty,['--headless','--path',empty,'--main-pack',exported.output,'res://generated/react/scenes/app.tscn','--','--godot-react-business-verify'],'packed-production',{generation:exported.generation,entryId:'app'});
runs.push({mode:'production',kind:'empty-directory-PCK',generation:exported.generation,...packed});

const watchedProject=path.join(work,'watched-project');await copyProject(watchedProject);
const abort=new AbortController(),events=[],outputs=new Map();
const watching=watchProject({projectRoot:watchedProject,godot:path.resolve(binary),entry:'app',headless:true,signal:abort.signal,pollMs:100,onEvent:event=>{events.push(event);if(event.event==='preview-output')outputs.set(event.generation,(outputs.get(event.generation)??'')+event.text);}});
const waitFor=async predicate=>{for(let turn=0;turn<900;turn++){const error=events.find(e=>e.event==='error'||e.event==='preview-error');if(error)throw Error(JSON.stringify(error));const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Native watch restart timed out');};
const config=await loadConfig({projectRoot:watchedProject,godot:path.resolve(binary)});
async function nativeProcesses(){const result=[];for(const filename of await activeRunLeases(config)){const item=JSON.parse(await fs.readFile(path.join(watchedProject,'generated/react/run-leases',filename),'utf8'));if(item.pid!==process.pid)result.push(item);}return result;}
let first,second;
try{
  first=await waitFor(async()=>{const native=await nativeProcesses(),started=events.find(e=>e.event==='preview-started');return started&&outputs.get(started.generation)?.includes('GODOT_REACT_BOOT_REPORT ')&&native[0];});
  await fs.appendFile(path.join(watchedProject,'src/App.tsx'),'\n// watch restarts this generation\n');
  second=await waitFor(async()=>{const native=await nativeProcesses(),started=events.filter(e=>e.event==='preview-started');return started.length>=2&&outputs.get(started[1].generation)?.includes('GODOT_REACT_BOOT_REPORT ')&&native.find(item=>item.pid!==first.pid);});
  if(processAlive(first.pid))throw Error('Old native preview still alive after generation restart');
}finally{abort.abort();await watching;}
const exits=events.filter(event=>event.event==='preview-exited');
if(exits.length!==2||exits[0].generation===exits[1].generation)throw Error('Expected two distinct completed native preview generations');
for(const [index,event]of exits.entries()){
  await fs.writeFile(path.join(work,`watch-${index}.log`),event.stdout+event.stderr);
  assertNoInspectorTransportErrors(event.stdout+event.stderr);
  assertCleanExecution(event,{generation:event.generation,entryId:'app'});
}
if((await activeRunLeases(config)).length||processAlive(second.pid))throw Error('Native watch left a live process or reader lease');
await assertNativeCertificate(nativeCertificate);
if(await sdkFingerprint()!==sdkSourceHash)throw Error('SDK changed during review regression certification');
const report={schemaVersion:1,passed:true,nativeCertificate,sdkSourceHash,editorIsolation,runtimeDebuggerPort:0,runs,
  watch:{passed:true,oldPid:first.pid,newPid:second.pid,generations:exits.map(event=>event.generation),allChildrenExited:true,leasesReleased:true}};
await fs.writeFile(path.join(work,'review-regressions.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,runs:runs.length,watch:true,report:path.join(work,'review-regressions.json')}));

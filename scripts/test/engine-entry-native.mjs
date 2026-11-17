/** Same-source Entry -> direct renderer -> native Observer -> bounded native quit. */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createSourceSnapshot,createBuildPlan,packBuildPlan} from '../../packages/project-tools/dist/build-plan.js';
import {buildEngineVendor,runtimeModuleSource} from '../../apps/playground/scripts/full-engine-release.mjs';
import {generateNativeInterface} from '../jsb.react-build/dist/native-interfaces.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const binary=path.resolve(option('--godot',path.join(repo,'tests/bin/godot-host-qjs'))),out=path.resolve(option('--out',path.join(repo,'work/engine-entry-native')));
const requireNoLegacy=args.includes('--require-no-legacy');
const profiling=args.includes('--profile'),counts=option('--counts','1000,10000').split(',').map(Number);
if(counts.some(count=>!Number.isSafeInteger(count)||count<1||count>10000))throw Error('Probe counts must be between 1 and 10000');
await fs.mkdir(out,{recursive:true});
const schema={version:1,nativeLeaf:'Node',callbacks:['_ready','_process','_physics_process'],rpc:{rpcPing:{arguments:['integer'],mode:'anyPeer',sync:'local'}}};
const generated=generateNativeInterface(schema,{profile:'entry_probe',renderer:'engine',generatedDir:'generated/entry'});
const vendor=await buildEngineVendor();
const runtimeModules=Object.fromEntries(Object.entries({'react':'React','@godot-js/react/engine':'engineReact','@godot-js/react/engine-native-interfaces':'engineNativeInterfaces'}).map(([name,key])=>[name,new TextEncoder().encode(runtimeModuleSource(key))]));
const results=[];
for(const count of counts){
 const directory=path.join(out,String(count));await fs.mkdir(directory,{recursive:true});
 const source=`import * as React from 'react';
import {EngineNode,createRoot,useFrame} from '@godot-js/react/engine';
import {defineNativeInterface,useEngineNativeInterface} from '@godot-js/react/engine-native-interfaces';
import Endpoint from './${generated.relativeSource.replace(/\.ts$/,'')}';
const G=require('godot');
const schema=${JSON.stringify(schema)},token=defineNativeInterface('entry_probe',schema);
export function start(ctx:any){
 const native=require('godot-jsb').internal.native_runtime;
 const assert=(value:any,message:string)=>{if(!value)throw Error(message);};
 assert(ctx.entry&&ctx.lifetime&&ctx.host,'Entry must be installed by the native bootstrap');
 assert(native.observationAbi===1&&native.lifecycleAbi===1&&native.checkpointAbi===1,'Matching native integration is required');
 ${requireNoLegacy?"assert(native.legacyReact===false&&require('godot-jsb').internal.react===undefined,'The final probe requires a native build without the legacy renderer');assert(typeof native.requestReleaseBatch==='function','The final probe requires native retirement frontiers');":''}
 ctx.entry.assertActive(ctx.host);
 const forged={...ctx.entry,assertActive(){},attachCleanup(){return()=>{};}};
 let rejected=false;try{createRoot(ctx.mount,{entry:forged,autoProcess:false});}catch(error){rejected=String(error).includes('E_ENGINE_ENTRY');}
 assert(rejected,'Forged entry methods must fail the native realm validator');
 let ready=0,process=0,physics=0,pings=0,frames=0,cancelled=false,baseline:any,baselineReads=0,childReads=0,idleChildReads:number|null=null,finished=false,cleanupStarted=0;
 const prototype=G.Node.prototype,original=prototype.get_children;
 try{prototype.get_children=function(...args:any[]){childReads++;return original.apply(this,args);};}catch(_){}
 const countChildReads=prototype.get_children!==original;
 const profile:any={calls:{},milliseconds:{},registered:[]};
 ${profiling?`for(const [target,names]of [[prototype,['get_children','get_parent','get_instance_id','remove_child','queue_free']],[G,['is_instance_valid','instance_from_id']]] as any){for(const name of names){const original=target[name];if(typeof original!=='function')continue;try{const wrapped=function(this:any,...args:any[]){const start=Date.now();try{return original.apply(this,args);}finally{if(cancelled){profile.calls[name]=(profile.calls[name]??0)+1;profile.milliseconds[name]=(profile.milliseconds[name]??0)+Date.now()-start;if(name==='queue_free'&&profile.calls[name]%1000===0)console.log('ENGINE_ENTRY_RELEASE_PROGRESS '+JSON.stringify({released:profile.calls[name],milliseconds:Date.now()-cleanupStarted,profile}));}}};target[name]=wrapped;if(target[name]===wrapped)profile.registered.push(name);}catch(_){}}}`:''}
 const root=createRoot(ctx.mount,{entry:ctx.entry,onError:(error:any)=>{console.error('ENGINE_ENTRY_FAILED '+String(error));ctx.mount.get_tree().quit(1);}});
 ctx.lifetime.onCancel(()=>{cancelled=true;cleanupStarted=Date.now();${profiling?"console.log('ENGINE_ENTRY_CLOSING '+JSON.stringify({count:"+count+",profile}));":''}});
 ctx.lifetime.defer(async()=>{
  await Promise.resolve();const closed=await root.close();
  assert(closed.status==='complete','Root cleanup '+closed.status);assert(cancelled,'Entry cancellation must precede cleanup');assert(finished,'Idle proof must finish before native quit');
  ${requireNoLegacy?"assert(root.getStats().batchReleaseRequests===1&&root.getStats().releaseFrontiers===1,'The native retirement frontier must actually be used');":''}
  console.log('ENGINE_ENTRY_OK '+JSON.stringify({count:${count},entry:ctx.entry.entryId,worldId:native.worldId,ready,process,physics,pings,frames,cancelled,close:closed.status,stats:root.getStats(),idleRecordsVisited:0,idleChildReads,cleanupElapsedMs:Date.now()-cleanupStarted${profiling?',profile':''}}));
 });
 function App(){
  const ref=React.useRef<any>(null);
  useEngineNativeInterface(ref,token,{_ready(){ready++;},_process(){process++;},_physics_process(){physics++;},rpcPing(value:number,context:any){assert(value===7&&context.senderPeerId===0,'Native RPC snapshot');pings++;}});
  useFrame('process',()=>{
   frames++;
   if(frames===5){assert(ready===1&&process>0&&physics>0,'Native callback delivery');ref.current.rpcPing(7);}
   if(frames===10){baseline=root.getStats();baselineReads=childReads;}
   if(frames===30){
    const current=root.getStats();for(const field of ['auditRecordsVisited','retirementRecordsVisited','releaseRecordsVisited','publicationRecordsVisited','portalRecordsVisited'])assert(current[field]===baseline[field],'Idle traversal '+field);
    if(countChildReads)assert(childReads===baselineReads,'Idle get_children traversal');idleChildReads=countChildReads?childReads-baselineReads:null;assert(pings===1,'RPC delivery');
    finished=true;ctx.mount.get_tree().quit(0);
   }
  });
  return React.createElement(EngineNode,{ctor:G.Node,native:{name:'Business'}},React.createElement(EngineNode,{ctor:Endpoint,nativeInterface:token,native:{name:'Endpoint'},ref}),...Array.from({length:${count}},(_,key)=>React.createElement(EngineNode,{key,ctor:G.Node,native:{name:'N'+key}})));
 }
 root.render(React.createElement(App));
}
`;
 const files={'res://start.ts':source,['res://'+generated.relativeSource]:generated.source};
 const snapshot=await createSourceSnapshot(files),plan=await createBuildPlan(snapshot,{kind:'script',module:'res://start.ts'});
 const packed=await packBuildPlan(plan,{compilerOptions:{vendor,runtimeModules}});
 const pack=path.join(directory,'probe.pck');await fs.writeFile(pack,packed.pack);
 for(const [uri,bytes]of packed.prepared.files){const file=path.join(directory,'project',uri.slice(6));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
 const run=spawnSync(binary,['--headless','--audio-driver','Dummy','--main-pack',pack,'--fixed-fps','60','--quit-after','180'],{encoding:'utf8',timeout:45000,maxBuffer:8*1024*1024});
 const log=(run.stdout??'')+(run.stderr??'');await fs.writeFile(path.join(directory,'native.log'),log);process.stdout.write(log);
 const marker=log.match(/ENGINE_ENTRY_OK (\{[^\n]+\})/),passed=run.status===0&&!run.error&&!!marker&&!log.includes('ENGINE_ENTRY_FAILED');
 results.push({count,status:passed?'passed':'failed',exitCode:run.status,error:run.error?.message,telemetry:marker?JSON.parse(marker[1]):undefined,pack,log:path.join(directory,'native.log')});
}
const report={status:results.every(value=>value.status==='passed')?'passed':'failed',binary,binarySha256:createHash('sha256').update(await fs.readFile(binary)).digest('hex'),requireNoLegacy,checks:['same-source-runtime-bootstrap','explicit-entry-capability','generated-native-interface','ready-process-physics-rpc','observer-idle-no-full-scan','actual-retirement-before-complete','native-pre-exit-async-cleanup',...(requireNoLegacy?['legacy-renderer-absent']:[])],results};
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(report.status!=='passed')process.exitCode=1;

/** Public Schema4 portal admission while another root has queued retirement. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createSourceSnapshot,createBuildPlan,packBuildPlan} from '../../packages/project-tools/dist/build-plan.js';
import {buildEngineVendor,runtimeModuleSource} from '../../apps/playground/scripts/full-engine-release.mjs';
const args=process.argv.slice(2),option=(key,fallback)=>{const index=args.indexOf(key);return index<0?fallback:args[index+1];};
const binary=path.resolve(option('--godot','tests/bin/godot-host-qjs')),out=path.resolve(option('--out','work/native-portal-admission-probe'));
await fs.mkdir(out,{recursive:true});
const vendor=await buildEngineVendor(),runtimeModules=Object.fromEntries(Object.entries({'react':'React','@godot-js/react/engine':'engineReact'}).map(([name,key])=>[name,new TextEncoder().encode(runtimeModuleSource(key))]));
const results=[];
for(const mode of ['new','existing']){
 const project=path.join(out,mode);await fs.mkdir(project,{recursive:true});
 const source=`import * as React from 'react';import {createRoot,EngineNode} from '@godot-js/react/engine';const G=require('godot');
const check=(ok:any,label:string)=>{if(!ok)throw Error('E_LATE_PORTAL '+label);};
export function start(ctx:any){
 const tree=ctx.mount.get_tree();let owner:any,child:any,survivor:any,frames=0,rejection='',rejections:string[]=[],failed=false;
 const fail=(error:any)=>{failed=true;console.error('LATE_PORTAL_FAILED '+String(error));tree.quit(1);};
 const a=createRoot(ctx.mount,{entry:ctx.entry,autoProcess:false,onError:fail});
 a.render(React.createElement(EngineNode,{ctor:G.Node,childScope:'native-owned-opaque',ref:(value:any)=>{if(value)owner=value;}}));a.flush();
 const ownerId=owner.get_instance_id(),borrowed=new G.Node();owner.add_child(borrowed);
 const external=new G.Node();ctx.mount.add_child(external);
 const b=createRoot(external,{entry:ctx.entry,autoProcess:false,onError:(error:any)=>{rejection=String(error);rejections.push(rejection);}});
 const independent=new G.Node();ctx.mount.add_child(independent);const c=createRoot(independent,{entry:ctx.entry,autoProcess:false,onError:fail});
 c.render(React.createElement(EngineNode,{ctor:G.Node,ref:(value:any)=>{if(value)survivor=value;}}));c.flush();const survivorId=survivor.get_instance_id();
 const element=React.createElement(EngineNode,{ctor:G.Node,ref:(value:any)=>{if(value)child=value;}});
 const prepared=${JSON.stringify(mode)}==='existing'?b.portal(element,borrowed):undefined;
 if(prepared){b.render(b.portal(null,borrowed));b.flush();}
 a.close();
 Promise.resolve().then(async()=>{try{
  check(owner.is_queued_for_deletion(),'queued retirement window');
  try{b.render(prepared??b.portal(element,borrowed));b.flush();}catch(error){rejection=String(error);rejections.push(rejection);}
  for(let i=0;i<8;i++)await Promise.resolve();b.flush();
  check(rejections.some(value=>value.includes('closing or retiring')),'specific admission rejection: '+rejections.join('; '));check(!child,'late native child was never published');
  check(!child,'rejected child never materialized');
  const tick=G.Callable.create(()=>{try{
   if(++frames<5)return;tree.disconnect('process_frame',tick);
   check(!G.is_instance_id_valid(ownerId),'owner actually retired');check(G.is_instance_id_valid(survivorId),'other root survivor remains live');
   check(a.getCloseProgress().status==='complete','owner close completes');
   Promise.all([b.close(),c.close()]).then(([result,independentResult]:any[])=>{try{check(result.status===(${JSON.stringify(mode)}==='existing'?'failed':'complete'),'rejected commit closes explicitly');check(independentResult.status==='complete','independent root closes cleanly');check(!G.is_instance_id_valid(survivorId),'survivor retires only on its own close');console.log('LATE_PORTAL_CASE '+JSON.stringify({mode:${JSON.stringify(mode)},rejected:true,ownerRetired:true,otherRootSurvived:true,close:result.status,independentClose:independentResult.status}));tree.quit(0);}catch(error){fail(error);}});
  }catch(error){fail(error);}});tree.connect('process_frame',tick);
 }catch(error){fail(error);}});
}`;
 await fs.writeFile(path.join(project,'start.ts'),source);
 const snapshot=await createSourceSnapshot({'res://start.ts':source}),plan=await createBuildPlan(snapshot,{kind:'script',module:'res://start.ts'}),packed=await packBuildPlan(plan,{compilerOptions:{vendor,runtimeModules}});
 const pack=path.join(project,'probe.pck');await fs.writeFile(pack,packed.pack);
 const run=spawnSync(binary,['--headless','--audio-driver','Dummy','--main-pack',pack,'--fixed-fps','60','--quit-after','120'],{encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024});
 const log=(run.stdout??'')+(run.stderr??'');await fs.writeFile(path.join(project,'native.log'),log);
 const event=log.split('\n').find(line=>line.includes('LATE_PORTAL_CASE '));
 const errors=log.split('\n').filter(line=>/^(?:ERROR:|SCRIPT ERROR:)|LATE_PORTAL_FAILED|Leaked instance|FATAL ERROR/.test(line));
 const expectedDiagnostics=mode==='existing'?errors.filter(line=>line.includes('E_ENGINE_CLEANUP')||line.includes('E_ENTRY_CLEANUP')):[];
 const unexpectedErrors=errors.filter(line=>!expectedDiagnostics.includes(line));
 results.push({mode,status:(run.status===0||mode==='existing'&&run.status===1)&&!!event&&!unexpectedErrors.length?'passed':'failed',exitCode:run.status,event:event?JSON.parse(event.slice(event.indexOf('LATE_PORTAL_CASE ')+'LATE_PORTAL_CASE '.length)):undefined,expectedDiagnostics,errors:unexpectedErrors,log:path.join(project,'native.log')});
}
const report={kind:'native-late-portal-admission',status:results.every(result=>result.status==='passed')?'passed':'failed',binary,binarySha256:createHash('sha256').update(await fs.readFile(binary)).digest('hex'),results};
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));assert.equal(report.status,'passed');

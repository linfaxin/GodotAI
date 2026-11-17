/** Actual owner-checkpoint release of opaque native subtrees and claim boundaries. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(path.join(root,'scripts/jsb.react/package.json'));
const ts=require('typescript'),{build}=require('esbuild'),args=process.argv.slice(2),option=(key,fallback)=>{const index=args.indexOf(key);return index<0?fallback:args[index+1];};
const binary=path.resolve(option('--godot',path.join(root,'tests/bin/godot-host-qjs'))),out=path.resolve(option('--out',path.join(root,'work/native-retirement-probe')));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),binarySha256=hash(await fs.readFile(binary));
await fs.mkdir(out,{recursive:true});
const cases=['foreign-live','foreign-retiring','foreign-quarantined','foreign-internal','same-scope-live','same-scope-retiring','same-scope-quarantined','mixed-frontiers','opaque-unclaimed','complete-claimed','overlapping-frontiers'];
const results=[];
for(const mode of cases){
 const project=path.join(out,mode);await fs.mkdir(path.join(project,'.godot/GodotJS'),{recursive:true});
 await fs.writeFile(path.join(project,'project.godot'),'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[GodotJS]\nruntime/debugger/debugger_port=0\n');
 await fs.writeFile(path.join(project,'main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://Probe.ts" id="1"]\n[node name="RetirementProbe" type="Node"]\nscript=ExtResource("1")\n');
 const success=mode==='opaque-unclaimed'||mode==='complete-claimed';
 const source=`const G=require('godot');const mode=${JSON.stringify(mode)},allowed=${success};const check=(ok,label)=>{if(!ok)throw Error('E_RETIREMENT_PROBE '+mode+' '+label);};
export default class Probe extends G.Node{
 _ready(){
  const R=require('godot-jsb').internal.native_runtime;check(R.lifecycleAbi===1&&R.observationAbi===1,'matching native integration required');
  const scope=R.openScope(),other=R.openScope(),parent=new G.Node(),child=new G.Node();this.add_child(parent);R.claim(scope,parent);
  const created=[parent,child],frontier=[parent],descriptors=[{node:parent,parent:this,children:[],opaque:true}];
  let childParent=parent;
  if(mode==='foreign-internal'||mode==='overlapping-frontiers'){const middle=new G.Node();created.push(middle);parent.add_child(middle,false,1);childParent=middle;}
  childParent.add_child(child,false,mode==='foreign-internal'?1:0);
  if(mode.startsWith('foreign-')||mode==='mixed-frontiers')R.claim(other,child);
  else if(mode!=='opaque-unclaimed')R.claim(scope,child);
  if(mode.endsWith('-retiring'))R.requestRelease(mode.startsWith('foreign-')?other:scope,child);
  if(mode.endsWith('-quarantined'))R.relinquish(mode.startsWith('foreign-')?other:scope,child);
  if(mode==='opaque-unclaimed'){const internal=new G.Node();created.push(internal);parent.add_child(internal,false,1);}
  if(mode==='complete-claimed'){descriptors[0].children=[child];descriptors.push({node:child,parent,children:[],opaque:false});}
  if(mode==='mixed-frontiers'){const ready=new G.Node();created.push(ready);this.add_child(ready);R.claim(scope,ready);descriptors.unshift({node:ready,parent:this,children:[],opaque:true});frontier.unshift(ready);}
  if(mode==='overlapping-frontiers'){descriptors.push({node:child,parent:childParent,children:[],opaque:true});frontier.push(child);}
  const ids=created.map(node=>String(node.get_instance_id())),before=JSON.stringify([R.status(scope),R.status(other)]);let submitted=false,ticks=0,done=false,accepted=false,rejection='';
  R.setCleanupHandlers(()=>{Promise.resolve().then(()=>{
   try{accepted=R.requestReleaseBatch(scope,descriptors,frontier)===true;}catch(error){rejection=String(error);}
   check(accepted===allowed,'batch admission');
   if(!allowed){check(rejection.includes('E_NATIVE_RELEASE_'),'specific rejection');check(JSON.stringify([R.status(scope),R.status(other)])===before,'rejected batch changed claims');check(frontier.every(node=>!node.is_queued_for_deletion()),'rejected batch queued a frontier');}
   else check(frontier.every(node=>node.is_queued_for_deletion()),'accepted batch did not queue frontier');
   submitted=true;
  });},()=>{
   if(!submitted||++ticks<2)return {status:'closing',pendingStartup:0,pendingCleanups:1};
   const live=ids.map(id=>G.is_instance_id_valid(BigInt(id)));
   if(allowed){if(R.status(scope).pending!==0)return {status:'closing',pendingStartup:0,pendingCleanups:1};check(live.every(value=>!value),'cascade did not actually retire');}
   else{check(live.every(Boolean),'rejected cascade destroyed a retained node');check(JSON.stringify([R.status(scope),R.status(other)])===before,'rejected batch changed later claims');}
   done=true;console.log('NATIVE_RETIREMENT_CASE '+JSON.stringify({mode,accepted,retained:!allowed,actualRetired:allowed,rejection}));return {status:'complete',pendingStartup:0,pendingCleanups:0};
  },()=>{check(done,'sealed before verification');});this.get_tree().quit(0);
 }
}`;
 await fs.writeFile(path.join(project,'Probe.ts'),source);
 await fs.writeFile(path.join(project,'.godot/GodotJS/Probe.js'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText);
 const run=spawnSync(binary,['--headless','--audio-driver','Dummy','--path',project,'--fixed-fps','60','--quit-after','120'],{encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});
 const log=(run.stdout??'')+(run.stderr??'');await fs.writeFile(path.join(project,'native.log'),log);
 const event=log.split('\n').find(line=>line.includes('NATIVE_RETIREMENT_CASE ')),errors=log.split('\n').filter(line=>/^(?:ERROR:|SCRIPT ERROR:)|Leaked instance|FATAL ERROR/.test(line));
 const observed=event?JSON.parse(event.slice(event.indexOf('NATIVE_RETIREMENT_CASE ')+'NATIVE_RETIREMENT_CASE '.length)):undefined;
 results.push({mode,status:run.status===0&&!run.error&&observed?.accepted===success&&errors.length===0?'passed':'failed',exitCode:run.status,signal:run.signal,error:run.error?.message,observed,errors,log:path.join(project,'native.log')});
}
// The release barrier must preserve ordinary cooperation between a native
// opaque owner and a different renderer scope using its registered portal.
{
 const mode='borrowed-portal',project=path.join(out,mode);await fs.mkdir(path.join(project,'.godot/GodotJS'),{recursive:true});
 await fs.writeFile(path.join(project,'project.godot'),'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[GodotJS]\nruntime/debugger/debugger_port=0\n');
 await fs.writeFile(path.join(project,'main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://Probe.ts" id="1"]\n[node name="PortalProbe" type="Node"]\nscript=ExtResource("1")\n');
 const source=`import * as React from 'react';import {createRoot,EngineNode} from '@godot-js/react/engine';const G=require('godot');const check=(ok:any,label:string)=>{if(!ok)throw Error('E_RETIREMENT_PORTAL '+label);};
export default class Probe extends G.Node{
 a:any;b:any;external:any;closing=false;failed=false;frames=0;
 fail(error:any){if(this.failed)return;this.failed=true;console.error('NATIVE_RETIREMENT_PORTAL_FAILED '+String(error));this.get_tree().quit(1);}
 _ready(){try{
  let owner:any,child:any;this.a=createRoot(this,{autoProcess:false,onError:(error:any)=>this.fail(error)});
  this.a.render(React.createElement(EngineNode,{ctor:G.Node,childScope:'native-owned-opaque',ref:(value:any)=>{if(value)owner=value;},native:{name:'OpaqueOwner'}}));this.a.flush();check(owner,'owner published');
  const borrowed=new G.Node();owner.add_child(borrowed);this.external=new G.Node();this.add_child(this.external);
  this.b=createRoot(this.external,{autoProcess:false,onError:(error:any)=>this.fail(error)});
  this.b.render(this.b.portal(React.createElement(EngineNode,{ctor:G.Node,ref:(value:any)=>{if(value)child=value;},native:{name:'PortalChild'}}),borrowed));this.b.flush();
  check(child&&child.get_parent()===borrowed,'separate-scope child published in borrowed mount');
  const ownerId=String(owner.get_instance_id()),childId=String(child.get_instance_id()),mountId=String(this.external.get_instance_id());this.closing=true;
  this.a.close().then(async(a:any)=>{const b=await this.b.close();check(a.status==='complete'&&b.status==='complete','both scopes close cooperatively');check(!G.is_instance_id_valid(BigInt(ownerId))&&!G.is_instance_id_valid(BigInt(childId)),'actual owner and portal child retired');check(G.is_instance_id_valid(BigInt(mountId)),'independent borrowed root mount retained');console.log('NATIVE_RETIREMENT_CASE '+JSON.stringify({mode:'borrowed-portal',accepted:true,ownerClose:a.status,portalClose:b.status,independentMountRetained:true}));this.get_tree().quit(0);}).catch((error:any)=>this.fail(error));
 }catch(error){this.fail(error);}}
 _process(delta:number){if(this.failed)return;try{check(++this.frames<120,'portal close deadline');if(this.closing)this.a.session.drainClose();else{this.a.processFrame(delta);this.b.processFrame(delta);}}catch(error){this.fail(error);}}
}`;
 await fs.writeFile(path.join(project,'Probe.ts'),source);
 const bundle=await build({stdin:{contents:source,resolveDir:project,sourcefile:'Probe.ts',loader:'ts'},outfile:path.join(project,'.godot/GodotJS/Probe.js'),bundle:true,write:false,format:'cjs',platform:'neutral',target:'es2022',external:['godot','godot-jsb'],inject:[path.join(root,'scripts/jsb.react/dist/internal/performance.mjs')],define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'engine-sdk',setup(b){b.onResolve({filter:/^(?:react|@godot-js\/react)(?:\/.*)?$/},args=>({path:require.resolve(args.path)}));}}]});
 await fs.writeFile(path.join(project,'.godot/GodotJS/Probe.js'),bundle.outputFiles[0].contents);
 const run=spawnSync(binary,['--headless','--audio-driver','Dummy','--path',project,'--fixed-fps','60','--quit-after','180'],{encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});
 const log=(run.stdout??'')+(run.stderr??'');await fs.writeFile(path.join(project,'native.log'),log);
 const event=log.split('\n').find(line=>line.includes('NATIVE_RETIREMENT_CASE ')),errors=log.split('\n').filter(line=>/^(?:ERROR:|SCRIPT ERROR:)|Leaked instance|FATAL ERROR/.test(line));
 const observed=event?JSON.parse(event.slice(event.indexOf('NATIVE_RETIREMENT_CASE ')+'NATIVE_RETIREMENT_CASE '.length)):undefined;
 results.push({mode,status:run.status===0&&!run.error&&observed?.ownerClose==='complete'&&observed?.portalClose==='complete'&&observed?.independentMountRetained&&errors.length===0?'passed':'failed',exitCode:run.status,signal:run.signal,error:run.error?.message,observed,errors,log:path.join(project,'native.log')});
}
if(hash(await fs.readFile(binary))!==binarySha256)throw Error('Native binary changed during retirement verification');
const report={schemaVersion:1,kind:'godotjs-native-opaque-retirement-acceptance',status:results.every(item=>item.status==='passed')?'passed':'failed',binary,binarySha256,results};
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(report.status!=='passed')process.exitCode=1;

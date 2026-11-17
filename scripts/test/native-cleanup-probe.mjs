/** Real native pre-exit gate: success, replenishing queue timeout, single-job abort. */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(repository,'scripts/jsb.react/package.json'));
const ts=require('typescript');
const args=process.argv.slice(2),option=(name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:args[index+1];};
const binary=path.resolve(option('--godot',path.join(repository,'tests/bin/godot-host-qjs')));
const out=path.resolve(option('--out',path.join(repository,'work/native-cleanup-probe')));
await fs.mkdir(out,{recursive:true});
const results=[];
for(const mode of option('--modes','complete,batch,starvation,nonreturning,syncnonreturning').split(',')){
 if(!['complete','batch','starvation','nonreturning','syncnonreturning'].includes(mode))throw Error('Unknown cleanup probe mode '+mode);
 const project=path.join(out,mode);await fs.mkdir(path.join(project,'.godot/GodotJS'),{recursive:true});
 await fs.writeFile(path.join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Native cleanup probe"\nrun/main_scene="res://main.tscn"\n[GodotJS]\nruntime/debugger/debugger_port=0\n');
 await fs.writeFile(path.join(project,'main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://Probe.ts" id="1"]\n[node name="Probe" type="Node"]\nscript=ExtResource("1")\n');
 const source=`const G=require('godot');export default class Probe extends G.Node {
 _ready(){
  const R=require('godot-jsb').internal.native_runtime;
  if(R.lifecycleAbi!==1||R.observationAbi!==1)throw Error('actual native integration is required');
  const scope=R.openScope(),child=new G.Node();this.add_child(child);R.claim(scope,child);
  ${mode==='batch'?`const leaf=new G.Node();child.add_child(leaf);R.claim(scope,leaf);`:''}
  let began=false,done=false,jobs=0,ticks=0,sealed=false;
  R.setCleanupHandlers(()=>{
   began=true;console.log('NATIVE_CLEANUP_BEGIN ${mode}');${mode==='batch'?'':'R.requestRelease(scope,child);child.queue_free();'}
   this.call_deferred('unexpectedCallback');
   ${mode==='batch'?`Promise.resolve().then(()=>{
      const descriptors=[{node:child,parent:this,children:[leaf],opaque:false},{node:leaf,parent:child,children:[],opaque:false}];
      let rejected=false;try{R.requestReleaseBatch(scope,descriptors,[leaf]);}catch(error){rejected=String(error).includes('E_NATIVE_RELEASE_FRONTIER');}
      if(!rejected||R.status(scope).retiring!==0||child.is_queued_for_deletion()||leaf.is_queued_for_deletion())throw Error('invalid batch partially changed native state');
      if(R.requestReleaseBatch(scope,descriptors,[child])!==true||!child.is_queued_for_deletion()||R.status(scope).retiring!==2)throw Error('native batch not admitted');
      done=true;
    });`:mode==='syncnonreturning'?'while(true){}':mode==='nonreturning'?'Promise.resolve().then(()=>{while(true){}});':`Promise.resolve().then(function next(){jobs++;${mode==='complete'?'if(jobs>=1200){done=true;return;}':''}Promise.resolve().then(next);});`}
  },()=>{
   ticks++;if(!began||sealed)throw Error('cleanup callback order');
   const pending=R.status(scope).pending;
   if(done&&pending===0){console.log('NATIVE_CLEANUP_COMPLETE '+JSON.stringify({jobs,ticks,pending}));return {status:'complete',pendingStartup:0,pendingCleanups:0};}
   return {status:'closing',pendingStartup:0,pendingCleanups:1};
  },()=>{sealed=true;console.log('NATIVE_CLEANUP_SEAL ${mode}');});
  this.get_tree().quit(0);
 }
 unexpectedCallback(){console.error('NATIVE_CLEANUP_UNEXPECTED_CALLBACK');}
}`;
 await fs.writeFile(path.join(project,'Probe.ts'),source);
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 await fs.writeFile(path.join(project,'.godot/GodotJS/Probe.js'),compiled);
 const result=spawnSync(binary,['--headless','--path',project,'--fixed-fps','60','--quit-after','120'],{encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});
 const logs=(result.stdout??'')+(result.stderr??'');await fs.writeFile(path.join(project,'native.log'),logs);
 const success=mode==='complete'||mode==='batch'?result.status===0&&logs.includes('NATIVE_CLEANUP_COMPLETE '):result.status!==0&&logs.includes(mode==='starvation'?'E_NATIVE_CLEANUP_TIMEOUT':'E_NATIVE_CLEANUP_ABORT');
 const sealExpected=mode==='complete'||mode==='batch'||(mode==='starvation'&&!logs.includes('E_NATIVE_CLEANUP_ABORT'));
 const passed=!result.error&&success&&logs.includes('NATIVE_CLEANUP_BEGIN '+mode)&&(!sealExpected||logs.includes('NATIVE_CLEANUP_SEAL '+mode))&&!logs.includes('NATIVE_CLEANUP_UNEXPECTED_CALLBACK');
 results.push({mode,status:passed?'passed':'failed',exitCode:result.status,signal:result.signal,error:result.error?.message,log:path.join(project,'native.log')});
 process.stdout.write(logs);
}
const report={status:results.every(result=>result.status==='passed')?'passed':'failed',binary,results};
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(report.status!=='passed')process.exitCode=1;

/** Direct renderer/local-scene proof. CLI editor import/export are separate gates. */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {importTemplate} from '../jsb.react-build/dist/template.js';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(repository,'scripts/jsb.react/package.json')),{build}=require('esbuild');
const argv=process.argv.slice(2),option=(key,fallback)=>{const at=argv.indexOf(key);return at<0?fallback:argv[at+1];};
const binary=path.resolve(option('--godot',process.env.GODOT??path.join(repository,'tests/bin/godot-host-qjs'))),out=path.resolve(option('--out',path.join(repository,'work/engine-template-native')));
await fs.mkdir(out,{recursive:true});const project=await fs.mkdtemp(path.join(out,'native-'));
await fs.cp(path.join(repository,'tests/react/local-resources'),project,{recursive:true,filter:name=>!name.includes('/.godot')&&!name.includes('/generated')&&!name.includes('/node_modules')});
// This probe has its own native Script driver; managed CLI admission is proved
// separately by previewProject and the fixture's verify.gd.
await fs.rm(path.join(project,'godot-react.config.mjs'),{force:true});
await fs.mkdir(path.join(project,'.godot/GodotJS'),{recursive:true});
const imported=await importTemplate('panel','templates/Panel.tscn',{root:project,hashes:{},hash:'a'.repeat(64)},path.join(project,'templates-generated'),{profile:'template-local-v1'});
await fs.writeFile(path.join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Direct engine templates"\nrun/main_scene="res://main.tscn"\n[GodotJS]\nruntime/debugger/debugger_port=0\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
await fs.writeFile(path.join(project,'main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://Probe.ts" id="1"]\n[node name="Probe" type="Node"]\nscript=ExtResource("1")\n');
const resource=imported.plan.resources[0];
const source=`import * as React from 'react';import {createRoot} from '@godot-js/react/engine';import {configureEngineComponents,engineNodeValue} from '@godot-js/react/engine-components';import App from './src/LocalResources';const G=require('godot');
const identity=(value:any)=>String(value.get_instance_id());const check=(value:any,message:string)=>{if(!value)throw Error(message);};
export default class Probe extends G.Node {
 root:any;lastA:any;lastMaterial='';b:any;bMaterial='';resets=0;failed=false;closing=false;frames=0;physicsRejected=false;
 _ready(){try{
  const api=require('godot-jsb').internal.resource_scopes;check(api?.abi===1,'native resource scope ABI');
  let attached=false;try{api.open(this);}catch(error){attached=String(error).includes('E_LOCAL_RESOURCE_ROOT');}check(attached,'attached roots must be rejected');
  const detached=new G.Node(),cap=api.open(detached),worldApi=require('godot-jsb').internal.native_runtime,worldCap=worldApi.openScope();
  let foreign=false;try{api.finish(worldCap);}catch(error){foreign=String(error).includes('E_LOCAL_RESOURCE_SCOPE');}check(foreign,'foreign native scope capabilities must be rejected');
  let wrongWorld=false;try{worldApi.status(cap);}catch(error){wrongWorld=String(error).includes('E_NATIVE_SCOPE');}check(wrongWorld,'resource scope capabilities must not enter the native world registry');worldApi.closeScope(worldCap);
  const leaseApi=require('godot-jsb').internal.engine_run_lease,leaseCap=leaseApi.open(this,'template-capability-probe','template-capability-instance','');
  let wrongLease=false;try{api.finish(leaseCap);}catch(error){wrongLease=String(error).includes('E_LOCAL_RESOURCE_SCOPE');}check(wrongLease,'lease capabilities must not enter the resource registry');
  let wrongResource=false;try{leaseApi.shutdownRequested(cap);}catch(error){wrongResource=String(error).includes('E_RUN_LEASE_CAPABILITY');}check(wrongResource,'resource capabilities must not enter the lease registry');leaseApi.close(leaseCap);
  check(api.close(cap)===true&&api.close(cap)===false,'capability close must be idempotent');
  let stale=false;try{api.finish(cap);}catch(error){stale=String(error).includes('E_LOCAL_RESOURCE_SCOPE');}check(stale,'stale capabilities must fail');detached.free();
  const genericRoot=new G.Node(),genericCap=api.open(genericRoot),generic=new G.Gradient();generic.resource_local_to_scene=true;
  const clone=api.remap(genericCap,generic);check(identity(clone)!==identity(generic)&&identity(clone.get_local_scene())===identity(genericRoot),'generic Resource class must duplicate without a renderer whitelist');
  const script=new G.GDScript();script.resource_local_to_scene=true;let rejectedScript=false;try{api.remap(genericCap,script);}catch(error){rejectedScript=String(error).includes('E_LOCAL_RESOURCE_SCRIPT');}check(rejectedScript,'script Resource graphs require an explicit contract');
  check(api.finish(genericCap)===true&&api.close(genericCap)===true,'generic resource setup and cleanup');genericRoot.free();
  this.root=createRoot(this,{autoProcess:false,onError:(error:any)=>this.fail(error)});configureEngineComponents(this.root,${JSON.stringify({assets:{[resource.resourceId]:{type:resource.type,uri:resource.uri}}})});
  this.root.render(React.createElement(App));this.root.flush();
 }catch(error){this.fail(error);}}
 fail(error:any){if(this.failed)return;this.failed=true;console.error('ENGINE_TEMPLATE_NATIVE_FAILED '+String(error));this.get_tree().quit(1);}
 _process(delta:number){if(this.failed)return;try{
  if(this.closing){this.root.session.drainClose();return;}this.root.processFrame(delta);if(++this.frames>240)throw Error('reset progress timeout');
  const world=this.get_node_or_null('LocalWorld');if(!world)return;const a=world.get_node('A'),b=world.get_node('B');if(this.lastA&&G.is_instance_valid(this.lastA)&&identity(a)===identity(this.lastA))return;
  const am=a.get('material'),bm=b.get('material');check(am&&identity(am)===identity(a.get_node('Caption').get('material')),'A aliases');check(bm&&identity(bm)===identity(b.get_node('Caption').get('material')),'B aliases');check(identity(am)!==identity(bm),'cross-instance isolation');
  const descriptor=(engineNodeValue(this.root,a) as any).read('material');check(descriptor?.kind==='asset'&&descriptor.id===${JSON.stringify(resource.resourceId)}&&descriptor.scope==='instance'&&descriptor.type==='CanvasItemMaterial'&&Object.isFrozen(descriptor)&&descriptor.get_instance_id===undefined,'typed reads must retain an immutable local-instance descriptor');
  check(identity(am.get_local_scene())===identity(a)&&identity(bm.get_local_scene())===identity(b),'local scene identities');check(identity(a.get_node('Caption').get('owner'))===identity(a)&&identity(b.get_node('Caption').get('owner'))===identity(b),'template owners');
  check(identity(G.ResourceLoader.load(${JSON.stringify(resource.uri)}))!==identity(am),'original resource must remain shared');
  if(this.lastA){check(!G.is_instance_valid(this.lastA),'old native root must retire');check(identity(am)!==this.lastMaterial,'old local resource identity must retire');check(identity(b)===identity(this.b)&&identity(bm)===this.bMaterial,'stable sibling');this.resets++;}else{this.b=b;this.bMaterial=identity(bm);}
  this.lastA=a;this.lastMaterial=identity(am);
  if(this.resets<20)world.get_node('ResetA').emit_signal('pressed');else{check(this.physicsRejected,'native physics stage must reject local resource allocation');this.closing=true;this.root.close().then((result:any)=>{check(result.status==='complete','actual root close');console.log('ENGINE_TEMPLATE_NATIVE_OK '+JSON.stringify({resets:this.resets,aliases:true,isolation:true,owners:true,localScene:true,sourcePreserved:true,physicsRejected:this.physicsRejected,close:result.status}));this.get_tree().quit(0);}).catch((error:any)=>this.fail(error));}
 }catch(error){this.fail(error);}}
 _physics_process(){if(this.physicsRejected||this.failed||this.closing)return;const node=new G.Node();try{require('godot-jsb').internal.resource_scopes.open(node);this.fail(Error('physics allocation accepted'));}catch(error){this.physicsRejected=String(error).includes('E_LOCAL_RESOURCE_TIMING');if(!this.physicsRejected)this.fail(error);}finally{node.queue_free();}}
}`;
await fs.writeFile(path.join(project,'Probe.ts'),source);
const bundle=await build({stdin:{contents:source,resolveDir:project,sourcefile:'Probe.ts',loader:'ts'},outfile:path.join(project,'.godot/GodotJS/Probe.js'),bundle:true,write:false,metafile:true,format:'cjs',platform:'neutral',target:'es2022',external:['godot','godot-jsb'],inject:[path.join(repository,'scripts/jsb.react/dist/internal/performance.mjs')],define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'engine-template-fixture',setup(b){b.onResolve({filter:/^@project\/react-templates\/panel$/},()=>({path:imported.module}));b.onResolve({filter:/^(?:react|@godot-js\/react)(?:\/.*)?$/},args=>({path:require.resolve(args.path)}));}}]});
if(Object.keys(bundle.metafile.inputs).some(name=>/(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:react-reconciler|scheduler)\//.test(name)))throw Error('E_RUNTIME_BUILD_IN_PROGRESS: complete the SDK build before running the native probe; the private reconciler wrapper is required');
await fs.writeFile(path.join(project,'.godot/GodotJS/Probe.js'),bundle.outputFiles[0].contents);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),binarySha256=digest(await fs.readFile(binary));
const result=spawnSync(binary,['--headless','--path',project,'--fixed-fps','60','--quit-after','300'],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
const logs=(result.stdout??'')+(result.stderr??'');await fs.writeFile(path.join(project,'native.log'),logs);
const binaryUnchanged=digest(await fs.readFile(binary))===binarySha256;
const passed=binaryUnchanged&&result.status===0&&!result.error&&logs.includes('ENGINE_TEMPLATE_NATIVE_OK ')&&!/ENGINE_TEMPLATE_NATIVE_FAILED|SCRIPT ERROR|^ERROR:|\[jsb\]\[Error\]/im.test(logs);
const report={status:passed?'passed':'failed',scope:'native-headless-direct-engine-template',binary,binarySha256,binaryUnchanged,project,exitCode:result.status,signal:result.signal,error:result.error?.message,checks:['imported-template-plan','scope-ABI','detached-root-boundary','foreign-capability-rejection','stale-capability','generic-native-resource-class','script-resource-rejection','physics-phase-rejection','native-aliases','instance-isolation','typed-local-resource-descriptor','native-owners','native-local-scene-identity','source-preservation','20-key-resets','persistent-sibling','actual-root-close'],limitations:['CLI editor import, verified export and Web/GPU are separate acceptance gates'],log:path.join(project,'native.log')};
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');process.stdout.write(logs);console.log(JSON.stringify(report,null,2));if(!passed)process.exitCode=1;

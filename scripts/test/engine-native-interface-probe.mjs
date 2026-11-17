/** Direct-renderer NativeInterface native proof; ENet/export remain separate fixtures. */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {generateNativeInterface} from '../jsb.react-build/dist/native-interfaces.js';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(repository,'scripts/jsb.react/package.json')),{build}=require('esbuild'),ts=require('typescript');
const argv=process.argv.slice(2),value=(name,fallback)=>{const at=argv.indexOf(name);return at<0?fallback:argv[at+1];};
const binary=path.resolve(value('--godot',process.env.GODOT??path.join(repository,'tests/bin/godot-host-qjs'))),out=path.resolve(value('--out',path.join(repository,'work/engine-native-interfaces')));
await fs.mkdir(out,{recursive:true});const project=await fs.mkdtemp(path.join(out,'native-'));await fs.mkdir(path.join(project,'.godot/GodotJS'),{recursive:true});
const schema=JSON.parse(await fs.readFile(path.join(repository,'tests/react_native_interfaces/interface.json'),'utf8'));
const generated=generateNativeInterface(schema,{profile:'endpoint',renderer:'engine'});
await fs.writeFile(path.join(project,'Endpoint.ts'),generated.source);
await fs.writeFile(path.join(project,'.godot/GodotJS/Endpoint.js'),ts.transpileModule(generated.source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},fileName:'Endpoint.ts'}).outputText);
const typed=argv.includes('--typed');
await fs.copyFile(path.join(repository,typed?'tests/react_native_interfaces/App.engine-typed.tsx':'tests/react_native_interfaces/App.engine.tsx'),path.join(project,'App.engine.tsx'));await fs.copyFile(path.join(repository,'tests/react_native_interfaces/interface.json'),path.join(project,'interface.json'));
await fs.writeFile(path.join(project,'project.godot'),'config_version=5\n[application]\nconfig/name="Engine native interfaces"\nrun/main_scene="res://main.tscn"\n[GodotJS]\nruntime/debugger/debugger_port=0\n');
await fs.writeFile(path.join(project,'main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://Probe.ts" id="1"]\n[node name="Probe" type="Node"]\nscript=ExtResource("1")\n');
const probe=`import * as React from 'react';import {createRoot} from '@godot-js/react/engine';import * as App from './App.engine';const G=require('godot');
export default class Probe extends G.Node {
 root:any;frames=0;closing=false;failed=false;
 _ready(){try{this.root=createRoot(this,{autoProcess:false,onError:(error:any)=>this.fail(error)});${typed?`require('@godot-js/react/engine-components').configureEngineComponents(this.root,{nativeScriptProfiles:{endpoint:{type:'Node2D',script:'res://Endpoint.ts',schemaHash:${JSON.stringify(generated.schemaHash)}}}});`:''}this.root.render(React.createElement(App.default,{round:0}));this.root.flush();}catch(error){this.fail(error);}}
 fail(error:any){if(this.failed)return;this.failed=true;console.error('ENGINE_NATIVE_INTERFACE_FAILED '+String(error));this.get_tree().quit(1);}
 _process(delta:number){if(this.failed)return;try{
  if(this.closing){this.root.session.drainClose();return;}
  this.root.processFrame(delta);this.frames++;
  if(this.frames===4){const event=new G.InputEventAction();event.action='ui_accept';event.pressed=true;G.Input.parse_input_event(event);}
  if(this.frames===8){this.root.render(React.createElement(App.default,{round:1}));this.root.flush();this.get_node('Endpoint').rpcPing(JSON.stringify({round:1}),'player:stable');}
  if(this.frames===16){
   const node=this.get_node('Endpoint'),script=node.get_script();if(node.get_class()!=='Node2D')throw Error('native leaf');
   if(!script.get_rpc_config())throw Error('native RPC metadata');
   const ready=App.events.filter(event=>event.method==='_ready'),ping=App.events.find(event=>event.method==='rpcPing');
   if(ready.length!==1||!ping||ping.handlerRound!==1||ping.args[0].round!==1||ping.args[2].senderPeerId!==0)throw Error('ready/RPC sender/latest handler');
   if(!App.frames.process||!App.frames.physics||!App.frames.input)throw Error('process/physics/input delivery');
   this.closing=true;this.root.close().then((result:any)=>{if(result.status!=='complete')throw Error('close '+result.status);console.log('ENGINE_NATIVE_INTERFACE_OK '+JSON.stringify({ready:ready.length,frames:App.frames,latestHandler:ping.handlerRound,sender:ping.args[2].senderPeerId,close:result.status}));this.get_tree().quit(0);}).catch((error:any)=>this.fail(error));
  }
 }catch(error){this.fail(error);}}
 _physics_process(delta:number){if(this.root&&!this.closing&&!this.failed)this.root.physicsFrame(delta);}
}`;
await fs.writeFile(path.join(project,'Probe.ts'),probe);
// The generated Script and the renderer must share one endpoint singleton.
await fs.mkdir(path.join(project,'node_modules/@godot-js/react/engine-native-interfaces'),{recursive:true});
const bundlePath=path.join(project,'.godot/GodotJS/Probe.js');
const primary=probe.replace("import * as App from './App.engine';", "const NI=require('@godot-js/react/engine-native-interfaces');globalThis.__engineNativeInterfaceProbe=NI;const App=require('./App.engine');");
const final=await build({stdin:{contents:primary,resolveDir:project,sourcefile:'Probe.ts',loader:'ts'},outfile:bundlePath,bundle:true,write:false,format:'cjs',platform:'neutral',target:'es2022',external:['godot','godot-jsb'],inject:[path.join(repository,'scripts/jsb.react/dist/internal/performance.mjs')],define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'engine-fixture-imports',setup(b){b.onResolve({filter:/^\.\/Endpoint$/},()=>({path:'res://.godot/GodotJS/Endpoint.js',external:true}));b.onResolve({filter:/^(?:react|@godot-js\/react)(?:\/.*)?$/},args=>({path:require.resolve(args.path)}));}}]});
await fs.writeFile(bundlePath,final.outputFiles[0].contents);await fs.writeFile(path.join(project,'node_modules/@godot-js/react/engine-native-interfaces/index.js'),'module.exports=globalThis.__engineNativeInterfaceProbe;\n');
const result=spawnSync(binary,['--headless','--path',project,'--quit-after','120','--fixed-fps','60'],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
const logs=(result.stdout??'')+(result.stderr??'');await fs.writeFile(path.join(project,'native.log'),logs);
const passed=result.status===0&&!result.error&&logs.includes('ENGINE_NATIVE_INTERFACE_OK ')&&!logs.includes('ENGINE_NATIVE_INTERFACE_FAILED');
const report={status:passed?'passed':'failed',scope:typed?'native-headless-typed-renderer-interface':'native-headless-direct-renderer-interface',exitCode:result.status,signal:result.signal,project,binary,checks:['generated-native-script','ready-once','process','physics','input','local-rpc-dto','sender-context','latest-handler','actual-root-close'],limitations:['No ENet two-peer transport or certified exporter evidence'],log:path.join(project,'native.log')};
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');process.stdout.write(logs);console.log(JSON.stringify(report,null,2));if(!passed)process.exitCode=1;

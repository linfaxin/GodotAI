declare const require:(id:string)=>any;const G=require('godot');
import * as React from '../../../scripts/jsb.react/node_modules/react';
import * as SDK from '../../../scripts/jsb.react/dist';
import {createGodotPort} from '../../../scripts/jsb.react/dist/godot';
import {prepareResourcePlan} from '../../../apps/playground/src/project-resources';
import {installProjectResources} from '../../../apps/playground/src/native-project-resources';
import {Services} from '../../../apps/playground/src/api';
import App from '../../../apps/playground/examples/parity-engine';
import project from '../../../apps/playground/examples/parity-engine.project.json';
const invoke=(o:any,n:string,...a:any[])=>(o[n]??o[n.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase())]).apply(o,a);
export default class ParityProbe extends G.Node{
 private tick:(()=>void)|undefined;_process(){this.tick?.();}
 _ready(){void this.start();}
 private async start(){let root:any,installed:any;const before=Number(G.AudioServer.bus_count??invoke(G.AudioServer,'get_bus_count'));const stop=(code:number)=>{try{root?.shutdown();}finally{if(installed){const result=installed.dispose();if(result.failures)throw Error('Cleanup failed');}}const after=Number(G.AudioServer.bus_count??invoke(G.AudioServer,'get_bus_count'));if(after!==before)throw Error('Audio bus leak '+before+' => '+after);invoke(invoke(this,'get_tree'),'quit',code);};try{
 const plan=await prepareResourcePlan(project.files as any,'parity_probe');installed=installProjectResources(G,plan);const native=createGodotPort(this,{rootId:'parity',rootInstance:'parity'});root=SDK.createRoot(native.port,native.containerKey,{generation:'parity',profileId:'showcase-v1',assets:installed.assets,onError:(e:any)=>console.error('PARITY_DIAG',String(e),e.stack)});let stats:any={},ticks=0;const services:any={scenes:installed.scenes,models:{},controls:{renderPixels:0},input:{},sound:()=>{},exportJSON:()=>{},stats:(s:any)=>stats=s};root.preloadAssets(Object.keys(installed.assets));root.pump();root.render(React.createElement(Services.Provider,{value:services},React.createElement(App)));root.pump();root.input({type:'InputEventKey',physical_keycode:74,pressed:true,ctrl_pressed:true});
 this.tick=()=>{try{if(ticks===2)root.input({type:'InputEventKey',physical_keycode:74,pressed:false,ctrl_pressed:false});root.pump(.016);root.physics(.016);root.process(.016);if(++ticks<120)return;const expected=['joints','physics2','physics3','isolated','nested','queue','morph','audio','viewport','pixels','ui','input','nav2','nav3','avoid2','avoid3'],failed=expected.filter(key=>stats[key]!==true);if(failed.length||root.getErrors().length)throw Error(JSON.stringify({failed,errors:root.getErrors().map(String),stats}));root.audit();this.tick=undefined;stop(0);console.log('SHOWCASE_PARITY_OK '+JSON.stringify(stats));}catch(error){this.tick=undefined;console.error('SHOWCASE_PARITY_FAILED',String(error),(error as any).stack);stop(1);}};
 }catch(error){console.error('SHOWCASE_PARITY_FAILED',String(error),(error as any).stack);stop(1);}}
}

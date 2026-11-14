import {prepareEngineProject} from '../../jsb.react-build/dist/core/engine-project.js';
import {packProject} from '../../jsb.react-browser/dist/pck.js';
import {buildEngineVendor} from '../../../apps/playground/scripts/full-engine-release.mjs';

const project=`config_version=5
[application]
config/name="Worker runtime verification"
[display]
window/size/viewport_width=320
window/size/viewport_height=240
[rendering]
renderer/rendering_method="gl_compatibility"
environment/defaults/default_clear_color=Color(0.05,0.1,0.2,1)
[GodotJS]
runtime/debugger/debugger_port=0
`;
const source=`import * as React from 'react';
import {EngineNode,useFrame} from '@godot-js/react/engine';
import {ColorRect,Color,Vector2,JavaScriptBridge,Callable} from 'godot';
const send=(type:string,data:any={})=>(globalThis as any).__probeSend({type,...data});
export default function App(){
 const [count,setCount]=React.useState(0),[failed,setFailed]=React.useState(false),ref=React.useRef<any>(null),frames=React.useRef(0);
 if(failed)throw Error('WORKER_REACT_FAILURE');
 React.useLayoutEffect(()=>{send('react-commit',{count,worker:typeof WorkerGlobalScope!=='undefined'&&globalThis instanceof WorkerGlobalScope,shared:typeof SharedArrayBuffer});},[count]);
 React.useEffect(()=>{
  const handler=(message:any)=>{if(message.type==='increment')setCount(x=>x+1);if(message.type==='react-fail')setFailed(true);if(message.type==='loop'){send('loop-entered');while(true){}}if(message.type==='throw')throw Error('WORKER_PROJECT_FAILURE');};
  (globalThis as any).__probeCommand=handler;
  const host=JavaScriptBridge.get_interface('window');
  const callback=JavaScriptBridge.create_callback(Callable.create((args:any)=>send('project-command-received',{raw:args.get(0)})));
  host.call('__godotjsSetProjectCommand',callback);host.call('__godotjsProjectEvent',JSON.stringify({type:'probe-ready'}));
  send('effect-mounted');return()=>{if(callback)host.call('__godotjsSetProjectCommand',null);send('effect-cleanup');delete (globalThis as any).__probeCommand;};
 },[]);
 useFrame('process',()=>{if(++frames.current===10)send('frames',{frames:frames.current,nativeClass:ref.current?.get_class(),color:ref.current?.color?.r});});
 return <EngineNode ctor={ColorRect} ref={ref} native={{position:new Vector2(10,10),size:new Vector2(120+count*10,80),color:new Color(count?0:1,count?1:0,0,1)}}/>;
}
`;
export async function makePack(mode='production'){
 const input=`import {Node,RigidBody2D,CollisionShape2D,CircleShape2D,Vector2,AudioServer} from 'godot';
 export default class InputProbe extends Node{
  body:any;frames=0;
  _ready(){this.body=new RigidBody2D();const collision=new CollisionShape2D();collision.shape=new CircleShape2D();this.body.add_child(collision);this.body.position=new Vector2(200,10);this.add_child(this.body);(globalThis as any).__probeSend({type:'audio-driver',name:AudioServer.get_driver_name()});}
  _physics_process(){if(++this.frames===30)(globalThis as any).__probeSend({type:'physics',frames:this.frames,y:this.body.position.y});}
  _input(event:any){const kind=event.get_class();(globalThis as any).__probeSend({type:'native-input',kind,pressed:kind==='InputEventKey'||kind==='InputEventMouseButton'?event.pressed:undefined,key:kind==='InputEventKey'?event.keycode:undefined,button:kind==='InputEventMouseButton'?event.button_index:undefined});}
 }`;
 const prepared=prepareEngineProject({runtime:'react',entry:'/src/App.tsx',files:{'/project.godot':project,'/src/App.tsx':source,'/src/Input.ts':input},vendor:await buildEngineVendor({mode})});
 if(prepared.diagnostics.some(d=>d.category==='error'))throw Error(JSON.stringify(prepared.diagnostics));
 const files=new Map(prepared.files),scene='res://.playground/engine-bootstrap.tscn';
 const text=new TextDecoder().decode(files.get(scene)).replace('load_steps=2','load_steps=3').replace('[node name=', '[ext_resource type="Script" path="res://src/Input.ts" id="2"]\n[node name=')+'\n[node name="InputProbe" type="Node" parent="."]\nscript = ExtResource("2")\n';
 files.set(scene,new TextEncoder().encode(text));
 return packProject(files).pack;
}
export function makeNativePack(){
 const source=`import {Node3D,Camera3D,MeshInstance3D,BoxMesh,StandardMaterial3D,BaseMaterial3D,Color,Vector3,FileAccess,Image} from 'godot';
 export default class Native3D extends Node3D{
  frames=0;
  _ready(){const camera=new Camera3D();camera.position=new Vector3(0,0,4);this.add_child(camera);camera.current=true;
   const mesh=new MeshInstance3D();mesh.mesh=new BoxMesh();const material=new StandardMaterial3D();material.shading_mode=0;material.albedo_color=new Color(0,0.3,1,1);mesh.material_override=material;this.add_child(mesh);
   const image=new Image(),error=image.load_png_from_buffer(FileAccess.get_file_as_bytes('res://probe.png'));if(error!==0)throw Error('PNG decode failed '+error);
   (globalThis as any).__probeSend({type:'asset-decoded',width:image.get_width(),height:image.get_height(),r:image.get_pixel(0,0).r,b:image.get_pixel(0,0).b});
  }
  _process(){if(++this.frames===10)(globalThis as any).__probeSend({type:'native3d-frames',frames:this.frames,worker:typeof WorkerGlobalScope!=='undefined'&&globalThis instanceof WorkerGlobalScope});}
 }`;
 const png=Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z/D/PwMDAwMTAxQAAC4IAwGyw9v6AAAAAElFTkSuQmCC','base64'));
 const prepared=prepareEngineProject({runtime:'godot',entry:'/src/Main.ts',files:{'/project.godot':project,'/src/Main.ts':source,'/probe.png':png}});
 return packProject(prepared.files).pack;
}

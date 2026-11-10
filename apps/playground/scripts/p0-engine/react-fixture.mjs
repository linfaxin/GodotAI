import {buildReactProbe} from './react-build.mjs';
const bytes=value=>new TextEncoder().encode(value);
export async function createReactFixture(){
 return {name:'react',marker:'P0_REACT_REPORT',files:new Map([
  ['res://project.godot',bytes('config_version=5\n[application]\nconfig/name="P0 direct React"\nrun/main_scene="res://main.tscn"\n[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=240\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[physics]\n2d/physics_engine="GodotPhysics2D"\n3d/physics_engine="GodotPhysics3D"\n[GodotJS]\nruntime/debugger/debugger_port=0\n')],
  ['res://main.tscn',bytes('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/react-probe.ts" id="1"]\n[node name="P0ReactProbe" type="Node"]\nscript = ExtResource("1")\n')],
  ['res://src/react-probe.ts',bytes('export default class P0ReactProbe {}\n')],
  ['res://.godot/GodotJS/src/react-probe.js',bytes(await buildReactProbe())],
  ['res://.godot/global_script_class_cache.cfg',bytes('list=Array[Dictionary]([])\n')],
 ])};
}

import {readFile} from 'node:fs/promises';
const encode=value=>new TextEncoder().encode(value);
export async function createApiFixture(options={}){
 const camel=options.camel??false;
 const source=await readFile(new URL('./api-probe.cjs',import.meta.url),'utf8');
 const files=new Map([
  ['res://src/ApiProbe.ts',encode('export default class ApiProbe {}\n')],
  ['res://.godot/GodotJS/src/ApiProbe.js',encode(source)],
  ['res://ApiProbe.tscn',encode('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/ApiProbe.ts" id="1"]\n[node name="ApiProbe" type="Node"]\nscript = ExtResource("1")\n')],
  ['res://.godot/global_script_class_cache.cfg',encode('list=Array[Dictionary]([])\n')],
  ['res://project.godot',encode('config_version=5\n[application]\nconfig/name="P0 native engine API"\nrun/main_scene="res://ApiProbe.tscn"\n[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=240\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\nruntime/core/camel_case_bindings_enabled='+String(camel)+'\n')],
 ]);
 return{name:camel?'api-camel':'api-snake',files,marker:'P0_API_REPORT',engineArgs:['--audio-driver','Dummy']};
}

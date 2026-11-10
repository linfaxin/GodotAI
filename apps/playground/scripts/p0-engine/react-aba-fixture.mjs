import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),bytes=value=>new TextEncoder().encode(value);
export async function createReactAbaFixture(){
 const compiled=await build({entryPoints:[path.join(here,'react-aba-probe.ts')],bundle:true,write:false,format:'cjs',platform:'neutral',target:'es2022',external:['godot'],sourcemap:'inline'});
 return {name:'react-aba',marker:'P0_REACT_ABA_REPORT',files:new Map([
  ['res://project.godot',bytes('config_version=5\n[application]\nconfig/name="P0 native ABA"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\n')],
  ['res://main.tscn',bytes('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/react-aba-probe.ts" id="1"]\n[node name="P0NativeAbaProbe" type="Node"]\nscript = ExtResource("1")\n')],
  ['res://src/react-aba-probe.ts',bytes('export default class P0NativeAbaProbe {}\n')],
  ['res://.godot/GodotJS/src/react-aba-probe.js',compiled.outputFiles[0].contents],
  ['res://.godot/global_script_class_cache.cfg',bytes('list=Array[Dictionary]([])\n')],
 ])};
}

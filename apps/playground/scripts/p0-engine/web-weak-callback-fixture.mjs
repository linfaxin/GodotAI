import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bytes = value => new TextEncoder().encode(value);
export async function createWebWeakCallbackFixture() {
    const compiled = await build({entryPoints: [path.join(here, 'web-weak-callback-probe.ts')], bundle: true, write: false,
        format: 'cjs', platform: 'neutral', target: 'es2022', external: ['godot'], sourcemap: 'inline'});
    return {name: 'web-weak-callback', marker: 'P0_WEB_WEAK_CALLBACK_REPORT', files: new Map([
        ['res://project.godot', bytes('config_version=5\n[application]\nconfig/name="P0 Web weak callback"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\n')],
        ['res://main.tscn', bytes('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/web-weak-callback-probe.ts" id="1"]\n[node name="P0WebWeakCallbackProbe" type="Node"]\nscript = ExtResource("1")\n')],
        ['res://src/web-weak-callback-probe.ts', bytes('export default class P0WebWeakCallbackProbe {}\n')],
        ['res://.godot/GodotJS/src/web-weak-callback-probe.js', compiled.outputFiles[0].contents],
        ['res://.godot/global_script_class_cache.cfg', bytes('list=Array[Dictionary]([])\n')],
    ])};
}

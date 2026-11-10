import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {auditEngineBinding} from './engine-api-binding-audit.mjs';

const binary=process.argv[2];if(!binary)throw Error('Usage: node verify-engine-api-runtime.mjs /absolute/godot [output-directory]');
const output=path.resolve(process.argv[3]??'work/playground/full-engine/binding-audit');
const reports={};
for(const mode of ['snake','camel']) {
 const directory=path.join(output,mode);await mkdir(path.join(directory,'.godot/GodotJS/src'),{recursive:true});await mkdir(path.join(directory,'src'),{recursive:true});
 await writeFile(path.join(directory,'project.godot'),`config_version=5\n[application]\nrun/main_scene="res://Main.tscn"\n[GodotJS]\nruntime/debugger/debugger_port=0\nruntime/core/camel_case_bindings_enabled=${mode==='camel'}\n`);
 await writeFile(path.join(directory,'Main.tscn'),'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/Main.ts" id="1"]\n[node name="Main" type="Node"]\nscript=ExtResource("1")\n');
 await writeFile(path.join(directory,'src/Main.ts'),'export default class Main {}\n');
 await writeFile(path.join(directory,'.godot/GodotJS/src/Main.js'),`const G=require('godot'),J=require('godot-jsb');const audit=${auditEngineBinding};exports.default=class Main extends G.Node{_ready(){const api=J.internal.get_engine_api(),file=G.FileAccess.open('res://api.json',2);file[J.internal.names.get_member('store_string')](JSON.stringify(api));file.close();console.log('API_BINDING_AUDIT '+JSON.stringify(audit(G,J)));}};`);
 const process=spawnSync(binary,['--headless','--path',directory,'--quit-after','4'],{encoding:'utf8',timeout:60000});
 const log=(process.stdout??'')+(process.stderr??'');await writeFile(path.join(directory,'engine.log'),log);
 const match=log.match(/API_BINDING_AUDIT (\{[^\n]+\})/);reports[mode]=match?JSON.parse(match[1]):{status:'failed',error:process.error?.message??'No report',exitCode:process.status};
 await writeFile(path.join(directory,'report.json'),JSON.stringify(reports[mode],null,2));
}
console.log(JSON.stringify(reports,null,2));if(Object.values(reports).some(report=>report.status!=='passed'))process.exitCode=1;

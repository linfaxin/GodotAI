import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import ts from 'typescript';
const repo=fileURLToPath(new URL('../../../../',import.meta.url)),out=path.join(repo,'work/playground/p0/integer-native');
const source=await readFile(new URL('./integer-native-probe.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{fileName:'integer-native-probe.ts',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:false,inlineSourceMap:true,inlineSources:true}}).outputText;
const files={
 'project.godot':'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\n',
 'main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/integer-native-probe.ts" id="1"]\n[node name="IntegerProbe" type="Node"]\nscript = ExtResource("1")\n',
 'src/integer-native-probe.ts':source,'.godot/GodotJS/src/integer-native-probe.js':compiled,
 '.godot/global_script_class_cache.cfg':'list=Array[Dictionary]([])\n',
};
for(const [name,text]of Object.entries(files)){const file=path.join(out,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);}
const engine=await realpath(process.env.GODOT??path.join(repo,'tests/bin/godot-host-qjs'));
const result=spawnSync(engine,['--headless','--path',out],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
const output=(result.stdout??'')+(result.stderr??'');await writeFile(path.join(out,'run.log'),output);process.stdout.write(output);
const marker='P0_INTEGER_NATIVE_REPORT ',line=output.split('\n').find(v=>v.includes(marker));const report=line?JSON.parse(line.slice(line.indexOf(marker)+marker.length)):null;
const hash=value=>createHash('sha256').update(value).digest('hex');
const evidence={status:result.status===0&&report?.status==='passed'?'passed':'failed',exitCode:result.status,engine:{path:engine,sha256:hash(await readFile(engine))},fixtureHashes:Object.fromEntries(Object.entries(files).map(([name,text])=>[name,hash(text)])),report};
await writeFile(path.join(out,'report.json'),JSON.stringify(evidence,null,2));if(evidence.status!=='passed')process.exitCode=1;

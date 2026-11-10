import {readFile, writeFile, mkdir, realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const output = path.resolve(process.env.P0_CAMEL_INVENTORY_OUTPUT ?? path.join(repo, 'work/playground/p0/camel-inventory-native'));
const source = await readFile(new URL('./camel-inventory-native-probe.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {fileName: 'camel-inventory-native-probe.ts', compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, inlineSourceMap: true, inlineSources: true,
}}).outputText;
const files = {
    'project.godot': 'config_version=5\n[application]\nconfig/name="Camel ClassDB inventory"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/debugger/debugger_port=0\nruntime/core/camel_case_bindings_enabled=true\n',
    'main.tscn': '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/camel-inventory-native-probe.ts" id="1"]\n[node name="CamelInventoryNativeProbe" type="Node"]\nscript = ExtResource("1")\n',
    'src/camel-inventory-native-probe.ts': source,
    '.godot/GodotJS/src/camel-inventory-native-probe.js': javascript,
    '.godot/global_script_class_cache.cfg': 'list=Array[Dictionary]([])\n',
};
for (const [name, text] of Object.entries(files)) {
    const filename = path.join(output, name);
    await mkdir(path.dirname(filename), {recursive: true});
    await writeFile(filename, text);
}
const engine = await realpath(process.env.GODOT ?? path.join(repo, 'tests/bin/godot-host-qjs'));
const run = spawnSync(engine, ['--headless', '--audio-driver', 'Dummy', '--path', output], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
});
const text = (run.stdout ?? '') + (run.stderr ?? '');
await writeFile(path.join(output, 'run.log'), text);
const marker = 'P0_CAMEL_INVENTORY_NATIVE_REPORT ';
const line = text.split('\n').find(value => value.includes(marker));
const report = line ? JSON.parse(line.slice(line.indexOf(marker) + marker.length)) : null;
const errors = text.split('\n').filter(value => /^(ERROR:|SCRIPT ERROR:)/.test(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const passed = run.status === 0 && report?.status === 'passed' && errors.length === 0;
const evidence = {status: passed ? 'passed' : 'failed', exitCode: run.status, signal: run.signal,
    engine: {path: engine, sha256: hash(await readFile(engine))},
    fixtureHashes: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])), report, errors};
await writeFile(path.join(output, 'report.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({status: evidence.status, registeredTotal: report?.registeredTotal, aliasRoundtrips: report?.aliasRoundtrips,
    eligibleRuntimeClasses: report?.eligibleRuntimeClasses, resolvedRuntimeClasses: report?.resolvedRuntimeClasses,
    skippedEditorClasses: report?.skippedEditorClasses?.length,
    collisions: report?.collisions, classNameRoundtrip: report?.classNameRoundtrip,
    roundtripMismatches: report?.roundtripMismatches, failures: report?.failures, error: report?.error,
    reportPath: path.join(output, 'report.json')}));
if (!passed) process.exitCode = 1;

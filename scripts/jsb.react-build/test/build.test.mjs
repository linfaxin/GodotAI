import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { buildProject, checkProject, doctorProject, loadConfig, bootstrapSource, recoverProject } from "../dist/index.js";
import { acquirePublisher } from "../dist/publication.js";
import { sha256 } from "../dist/fs.js";
import { validateRuntimeManifest } from "@godot-js/react/contracts";

async function project(t, source = 'import {Node,Label} from "@godot-js/react";export default function App(){return <Node name="App"><Label text="hello"/></Node>}') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "react-build-test-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src")); await fs.writeFile(path.join(root, "src/App.tsx"), source);
  await fs.writeFile(path.join(root, "godot-react.config.mjs"), 'export default {entries:{app:"src/App.tsx"}};');
  await fs.writeFile(path.join(root, "project.godot"), 'config_version=5\n[application]\nconfig/name="test"\n');
  return root;
}
test("Program rejects invalid host props and unresolved dependencies before output", async t => {
  const root = await project(t, 'import {Label} from "@godot-js/react";import {missing} from "missing-library";export default function App(){return <Label text={123} unexpected="x"/>}');
  await assert.rejects(checkProject({ projectRoot: root }), e => e.code === "E_TYPESCRIPT" && /missing-library/.test(e.message) && /number/.test(e.message));
  await assert.rejects(fs.access(path.join(root, "generated/react/active.json")));
});
test("build emits one canonical vendor and true NativeScript identity, doctor detects tampering", async t => {
  const root = await project(t);await fs.writeFile(path.join(root,"godot-react.config.mjs"),'export default {entries:{app:"src/App.tsx"},nativeInterfaces:{actor:{version:1,nativeLeaf:"Node",callbacks:["_ready"]}}};');
  const result = await buildProject({ projectRoot: root });
  assert.equal(result.manifest.entries.app.module, "entry-app");
  assert.equal(Object.keys(result.manifest.nativeScripts).length, 2);
  assert.equal(Object.keys(result.manifest.artifacts).filter(x => x.endsWith(".ts")).length, 2);
  assert(result.manifest.nativeScriptProfiles.actor.script.includes(`/interfaces/${result.generation}/`));
  const hub=await fs.readFile(path.join(root,result.manifest.entries.app.resourceHub.slice(6)),"utf8");assert(hub.includes(`type="Script" path="${result.manifest.nativeScriptProfiles.actor.script}"`));assert.match(hub,/metadata\/native_scripts = \[ExtResource\("native_1"\)\]/);
  assert.equal(result.manifest.modules.runtime.kind, "vendor");
  assert.equal(result.manifest.profile.id, "core-ui-v1");
  const bundle = await fs.readFile(path.join(root, result.manifest.modules["entry-app"].uri.slice(6)), "utf8");
  assert.match(bundle, /shim-/); assert.doesNotMatch(bundle, /react-reconciler\.production/);
  const map = JSON.parse(await fs.readFile(path.join(root, `${result.manifest.modules["entry-app"].uri.slice(6)}.map`), "utf8"));
  assert(map.sources.includes("res://src/App.tsx")); assert(map.mappings.length > 0); assert.equal(map.sourceRoot, "");
  for(const native of Object.values(result.manifest.nativeScripts)){const nativeMap=JSON.parse(await fs.readFile(path.join(root,`${native.output.slice(6)}.map`),"utf8"));assert.deepEqual(nativeMap.sources,[native.source]);assert.equal(nativeMap.sourceRoot,"");assert.equal(nativeMap.sourcesContent.length,1);}
  assert.equal((await doctorProject({ projectRoot: root })).ok, true);
  await fs.appendFile(path.join(root, result.manifest.modules["entry-app"].uri.slice(6)), "\ncorrupt\n");
  const doctor = await doctorProject({ projectRoot: root }); assert.equal(doctor.ok, false); assert(doctor.errors.some(x => x.includes("E_ARTIFACT_HASH")));
});
test("builder and native validator share the frozen v1 structural fixture", async () => { const value=JSON.parse(await fs.readFile(new URL("../../jsb.react/src/contracts/fixtures/runtime-manifest-v1.json",import.meta.url),"utf8")); assert.equal(validateRuntimeManifest(value).schemaVersion,1); });
test("stable bootstrap is generation independent", () => { const a = bootstrapSource("app", "generated/react"); assert.equal(sha256(a), sha256(bootstrapSource("app", "generated/react"))); assert.match(a, /active\.json/); assert.doesNotMatch(a, /fake/); });
test("publisher refuses live or malformed leases and never steals an owned lock", async t => {
  const root = await project(t), config = await loadConfig({ projectRoot: root }), leases = path.join(root, "generated/react/run-leases"); await fs.mkdir(leases, { recursive: true });
  await fs.writeFile(path.join(leases, "half-written.json"), "{");
  await assert.rejects(acquirePublisher(config, "test-g"), e => e.code === "E_RUN_ACTIVE");
  await fs.rm(path.join(leases, "half-written.json")); const publisher = await acquirePublisher(config, "test-g");
  try { await assert.rejects(acquirePublisher(config, "test-h"), e => e.code === "E_BUILD_BUSY"); await assert.rejects(recoverProject(config), e => e.code === "E_BUILD_BUSY"); } finally { await publisher.release(); }
});
test("template preflight rejects executable and black-box scene inputs", async t => {
  const root = await project(t); await fs.mkdir(path.join(root, "templates")); await fs.writeFile(path.join(root, "godot-react.config.mjs"), 'export default {entries:{app:"src/App.tsx"},templates:{bad:"templates/Bad.tscn"}};');
  await fs.writeFile(path.join(root, "templates/Bad.tscn"), '[gd_scene format=3]\n[ext_resource type="Script" path="res://bad.gd" id="1"]\n[node name="Bad" type="Node"]\nscript=ExtResource("1")\n');
  await assert.rejects(checkProject({ projectRoot: root }), e => e.code === "E_IMPORT_SCRIPT");
});
test("project policy rejects business autoloads and unmanaged main scenes without executing them",async t=>{const root=await project(t);await fs.appendFile(path.join(root,"project.godot"),'\n[autoload]\nRogue="*res://rogue.gd"\n');await assert.rejects(checkProject({projectRoot:root}),e=>e.code==="E_UNMANAGED_AUTOLOAD");await fs.writeFile(path.join(root,"project.godot"),'config_version=5\n[application]\nrun/main_scene="res://legacy.tscn"\n');await assert.rejects(checkProject({projectRoot:root}),e=>e.code==="E_ROOT_SCENE");});
test("entry registration checks required React props",async t=>{const root=await project(t,'import {Label} from "@godot-js/react";export default function App({title}:{title:string}){return <Label text={title}/>;}');await assert.rejects(checkProject({projectRoot:root}),e=>e.code==="E_TYPESCRIPT"&&/title/.test(e.message));});
test("default profile rejects directly authored physics hosts",async t=>{const root=await project(t,'import {CharacterBody2D} from "@godot-js/react";export default function App(){return <CharacterBody2D name="Actor"/>;}');await assert.rejects(checkProject({projectRoot:root}),e=>e.code==="E_PROFILE_UNSUPPORTED");});

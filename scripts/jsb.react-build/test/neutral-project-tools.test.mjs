import test from 'node:test';
import assert from 'node:assert/strict';
import {readProjectStringSetting} from '@godot-js/project-tools/project-settings';
import {readProjectStringSetting as compatibilitySetting} from '@godot-js/react-build/project-settings';
import {adaptLegacyLaunch,createSourceSnapshot,createBuildPlan,packBuildPlan} from '@godot-js/project-tools/build-plan';
import {prepareLegacyBuildPlan} from '../dist/core/index.js';
import {parseSceneText} from '../dist/core/scene-text.js';
import {bundleClosedModulesWith} from '../dist/core/module-loading.js';
import {BuildError} from '../dist/types.js';
const decode=new TextDecoder();
const files={'/project.godot':'[application]\nrun/main_scene="res://native.tscn"\n','/native.tscn':'[gd_scene format=3]\n[node name="Native" type="Node"]\n','/src/App.tsx':'export default function App(){return null;}'};

test('compatibility helper subpaths reference the single neutral implementation',()=>{
 assert.equal(readProjectStringSetting,compatibilitySetting);
});

test('legacy helper boundaries preserve BuildError code, name and opaque error identity',async()=>{
 assert.throws(()=>parseSceneText('[gd_scene]\n[node name="unterminated'),error=>error instanceof BuildError&&error.name==='GodotReactBuildError'&&error.code==='E_IMPORT_SYNTAX'&&error.message.startsWith('E_IMPORT_SYNTAX: '));
 const bundler={async build(){return {errors:[],warnings:[],metafile:{inputs:{'entry.ts':{bytes:1,imports:[{path:'unregistered',external:true,kind:'require-call'}]}},outputs:{}}};},async formatMessages(){return [];}};
 await assert.rejects(bundleClosedModulesWith(bundler,{},[]),error=>error instanceof BuildError&&error.code==='E_DYNAMIC_MODULE'&&error.name==='GodotReactBuildError');
 const original=Error('opaque third-party failure');
 await assert.rejects(bundleClosedModulesWith({...bundler,async build(){throw original;}},{},[]),error=>error===original);
});

test('legacy React build plans preserve startup semantics and include props/startup bytes in build identity',async()=>{
 const document={schemaVersion:3,runtime:'react',entry:'/src/App.tsx',mainScene:'res://native.tscn',files};
 const original=JSON.stringify(document),plan=await adaptLegacyLaunch(document);
 const vendor=new TextEncoder().encode('exports.React={};exports.engineReact={};');
 const first=await prepareLegacyBuildPlan(plan,{props:{value:1},compilerOptions:{vendor}});
 const second=await prepareLegacyBuildPlan(plan,{props:{value:2},compilerOptions:{vendor}});
 assert.notEqual(first.plan.buildKey,second.plan.buildKey);
 assert.match(decode.decode(first.prepared.files.get('res://project.godot')),/engine-bootstrap.tscn/);
 assert.match(decode.decode(first.prepared.files.get('res://.playground/engine-bootstrap.ts')),/__godotjsRuntimeHost/);
 assert.match(decode.decode(first.prepared.files.get('res://.playground/engine-bootstrap.ts')),/this.root.flush\(\)/);
 assert.equal(JSON.stringify(document),original);
});

test('legacy Node classes retain their registration host; new script entries use the ordinary start contract',async()=>{
 const nativeFiles={'/src/main.ts':'import {Node} from "godot"; export default class Main extends Node {}'};
 const native=await prepareLegacyBuildPlan(await adaptLegacyLaunch({schemaVersion:3,runtime:'godot',entry:'/src/main.ts',files:nativeFiles}));
 assert.match(decode.decode(native.prepared.files.get('res://.playground/engine-bootstrap.ts')),/Native entry must export a Godot Node class/);
 const snapshot=await createSourceSnapshot({'/src/start.ts':'export function start(ctx:any){}'}),plan=await createBuildPlan(snapshot,{kind:'script',module:'/src/start.ts'});
 const modern=await packBuildPlan(plan);
 assert.match(decode.decode(modern.prepared.files.get('res://.playground/engine-bootstrap.ts')),/Script entry must export a start function/);
 assert(modern.receipt.packSha256);
});

import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {buildProject,assertCleanExecution} from '../dist/index.js';

test('real native CLI keeps independent siblings and quarantines unknown managed children',{timeout:60000},async t=>{
 const binary=process.env.GODOT??fileURLToPath(new URL('../../../tests/bin/godot-host-qjs',import.meta.url));try{await access(binary);}catch{t.skip('Matching native fixture is unavailable');return;}
 const root=await mkdtemp(path.join(os.tmpdir(),'engine-cli-islands-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'src'));
 await writeFile(path.join(root,'project.godot'),'config_version=5\n[application]\nconfig/name="Native CLI islands"\n[godotjs]\nreact/enabled=true\n[GodotJS]\nruntime/debugger/debugger_port=0\n');
 await writeFile(path.join(root,'godot-react.config.mjs'),'export default {entries:{app:"src/App.tsx"},verification:{entry:"src/islands-verification.ts"}}');
 await writeFile(path.join(root,'src/App.tsx'),'import {Node,Label} from "@godot-js/react/engine-components";export default function App(){return <Node name="App"><Label text="owned"/></Node>}');
 await writeFile(path.join(root,'src/islands-verification.ts'),await readFile(new URL('../../../tests/react/fixture/src/islands-verification.ts',import.meta.url)));
 const build=await buildProject({projectRoot:root,godot:binary,importResources:false}),scene=build.manifest.entries.app.scene;
 const run=extra=>{const result=spawnSync(binary,['--headless','--audio-driver','Dummy','--path',root,scene,'--','--godot-react-business-verify',...extra],{cwd:root,encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});return {code:result.status,stdout:result.stdout??'',stderr:result.stderr??'',signal:result.signal};};
 const sibling=run([]);assert.equal(sibling.code,0,JSON.stringify(sibling));assertCleanExecution(sibling,{generation:build.generation,entryId:'app'});assert.match(sibling.stdout,/"independentSiblingSurvivesRootClose":true/);
 const injection=run(['--island-managed-injection']);assert.equal(injection.code,1,JSON.stringify(injection));assert.match(injection.stderr,/E_ENGINE_STRUCTURE/);assert.match(injection.stdout,/GODOT_REACT_ISLAND_RETAINED .*"unknownChildRetained":true.*"managedIslandRetained":true.*"unknownChildUnclaimed":true/);assert.doesNotMatch(injection.stdout,/GODOT_REACT_BUSINESS_VERIFIED/);
});

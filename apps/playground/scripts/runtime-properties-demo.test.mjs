import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimePropertiesDemo,matchesRuntimePropertiesDemo} from '../src/runtime-properties-demo.ts';
import {parseProject,exportProject,projectCompileRequest} from '../src/project-model.ts';
import {compileEngineProject} from '../src/engine-project.ts';
import {assertReplayIdentity,hasCleanRuntimeExit} from '../src/workbench/runtime-properties-replay.ts';

test('exported-property sample compiles as a native scene with a real decorated script',async()=>{
  const project=createRuntimePropertiesDemo('full-engine-v1');
  const document=exportProject(project);
  assert.equal(document.schemaVersion,4);
  assert.deepEqual(document.launch,{kind:'scene',source:'project'});
  assert.equal(project.mainScene,'res://main.tscn');
  assert.equal(project.entry,'');
  const compiled=await compileEngineProject({...projectCompileRequest(project),files:project.files});
  assert.deepEqual(compiled.diagnostics,[]);
  assert(compiled.pack.byteLength>0);
  assert(compiled.manifest.files.includes('res://main.tscn'));
  assert(compiled.manifest.files.includes('res://.godot/GodotJS/src/Player.js'));
  assert(compiled.manifest.files.includes('res://src/Player.ts'));
});

test('sample reuse preserves edited copies and Schema4 scene launch after save/reload',()=>{
  const sample=createRuntimePropertiesDemo('full-engine-v1');
  const restored=parseProject(exportProject(sample));
  assert(matchesRuntimePropertiesDemo(restored,sample));
  restored.files['/src/Player.ts']+='\n// user edit\n';
  assert(!matchesRuntimePropertiesDemo(restored,sample));
  assert(!matchesRuntimePropertiesDemo(createRuntimePropertiesDemo('engine-2d-v1'),sample));
  assert.deepEqual(exportProject(sample).launch,{kind:'scene',source:'project'});
});

test('replay requires every run identity field and actual zero-exit/complete cleanup facts',()=>{
  const run={runId:'run',revision:1,buildKey:'build',generation:2,documentId:'doc',workerId:'worker',runConfigurationHash:'a'.repeat(64)};
  assert.doesNotThrow(()=>assertReplayIdentity({...run},run));
  for(const key of Object.keys(run))assert.throws(()=>assertReplayIdentity({...run,[key]:'other'},run));
  const exit={evidence:'host-report',report:{reason:'clean-exit',sessionFacts:{nativeExit:{code:0},hostCleanup:'complete'}}};
  assert.equal(hasCleanRuntimeExit(exit),true);
  assert.equal(hasCleanRuntimeExit({...exit,evidence:'editor-local'}),false);
  assert.equal(hasCleanRuntimeExit({...exit,report:{reason:'clean-exit'}}),false);
  assert.equal(hasCleanRuntimeExit({...exit,report:{...exit.report,sessionFacts:{nativeExit:{code:1},hostCleanup:'complete'}}}),false);
  assert.equal(hasCleanRuntimeExit({...exit,report:{...exit.report,sessionFacts:{nativeExit:{code:0},hostCleanup:'failed'}}}),false);
});

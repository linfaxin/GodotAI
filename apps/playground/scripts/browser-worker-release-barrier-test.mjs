import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openProductHarness} from './browser-product-harness.mjs';

const source=await fs.readFile(new URL('../../../tests/browser-preflight/WorkerRawSignalBarrier.ts',import.meta.url),'utf8');
const producerInputs={script:createHash('sha256').update(await fs.readFile(new URL(import.meta.url))).digest('hex'),harness:createHash('sha256').update(await fs.readFile(new URL('./browser-product-harness.mjs',import.meta.url))).digest('hex'),fixture:createHash('sha256').update(source).digest('hex')};
const output=process.env.PLAYGROUND_RELEASE_BARRIER_REPORT;
let harness,report;
try{
 harness=await openProductHarness();
 const project={schemaVersion:3,engineProfile:harness.release.runtimeProfile,runtime:'godot',demoId:'native',entry:'/src/Main.ts',selected:'/src/Main.ts',mode:'production',controls:{},files:{
  '/src/Main.ts':source,'/project.godot':'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  '/main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/Main.ts" id="1"]\n[node name="Main" type="Node2D"]\nscript=ExtResource("1")\n',
 }};
 await harness.importProject(project);await harness.waitRunning();
 const event=await harness.until(async()=>{
  const observation=await harness.observation(),fatal=observation.telemetry.find(item=>item.type==='fatal');if(fatal)throw Error(JSON.stringify(fatal));
  return observation.telemetry.find(item=>item.type==='project'&&item.data?.type==='raw-native-signal-barrier')?.data;
 },'The raw native signal did not complete the private release checkpoint');
 assert.equal(event.passed,true);assert.equal(event.documentAbsent,true);assert.equal(event.role,'engine');assert.equal(event.phases.length,3);
 for(const phase of event.phases.slice(0,2)){assert.equal(phase.valid,true);assert.equal(phase.stats.releaseRequested,0);assert.equal(phase.stats.freed,0);}
 const checkpoint=event.phases[2];assert.equal(checkpoint.valid,false);assert.equal(checkpoint.stats.releaseRequested,1);assert.equal(checkpoint.stats.freed,1);assert.equal(checkpoint.stats.pendingReleases,0);assert.equal(checkpoint.stats.cleanExit,true);
 assert.equal(event.finalStats.releaseRequested,1);assert.equal(event.finalStats.freed,1);assert.equal(event.finalStats.cleanExit,true);
 assert.equal(event.foreign.moved,true);assert.equal(event.foreign.valid,true);assert.equal(event.foreign.parentIsOutside,true);assert.equal(event.foreign.stats.releaseRequested,0);assert.equal(event.foreign.stats.freed,0);assert.equal(event.foreign.stats.cleanExit,false);assert(event.foreign.errors.some(error=>error.message.includes('E_ENGINE_STRUCTURE')));
 const compiled=await harness.until(async()=>(await harness.observation()).compilations.find(item=>item.complete&&item.sources['res://src/Main.ts']===source),'The authored barrier project was not observed in the actual PCK');assert(!compiled.error);assert.equal(compiled.manifest.engineId,harness.release.engineId);
 assert.equal(compiled.artifactReceipt?.schemaVersion,2);assert.match(compiled.artifactReceipt.artifactId,/^[a-f0-9]{64}$/);assert.equal(compiled.artifactReceipt.artifactId,compiled.manifest.artifactId);assert.equal(compiled.artifactReceipt.packSha256,compiled.packSha256);
 const terminal=await harness.stop();assert.deepEqual(harness.pageErrors,[]);
 report=await harness.report({status:'passed',scope:'exact-candidate-raw-native-signal-release-barrier',engineExecuted:true,producerInputs,producerHash:createHash('sha256').update(JSON.stringify(producerInputs)).digest('hex'),fixtureSha256:producerInputs.fixture,checks:['A real native Button.pressed Callable invokes unmount and flush while its detached mount remains outside SceneTree','The emitter stays valid and no release is requested inside the raw native callback or after emit returns on the same stack','The private Promise checkpoint destroys the native object exactly once and preserves clean accounting','A raw child_order_changed callback can transfer the retiring object to an external parent; the renderer preserves it and reports a non-clean structure error','The formal product compiler, verified loader, RuntimeHost and PreviewRunner retire the complete Worker session'],event,artifact:{packSha256:compiled.packSha256,buildKey:compiled.manifest.buildKey,artifactReceipt:compiled.artifactReceipt},terminal,pageErrors:harness.pageErrors});
}catch(error){report={status:'failed',scope:'exact-candidate-raw-native-signal-release-barrier',error:String(error),stack:error.stack,...(harness?{candidateId:harness.candidateId,state:await harness.inspect().catch(()=>undefined),logs:await harness.page.locator('#logs').textContent().catch(()=>undefined),observation:await harness.observation().catch(()=>undefined)}:{})};process.exitCode=1;}
finally{if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}console.log(JSON.stringify(report,null,2));await harness?.close();}

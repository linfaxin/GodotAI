import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openProductHarness,assertProductCleanup} from './browser-product-harness.mjs';

const helper=await fs.readFile(new URL('../../../tests/browser-preflight/WorkerSourceMapCrash.tsx',import.meta.url),'utf8');
const helperPath='/src/nested/WorkerSourceMapCrash.tsx',helperUri='res://'+helperPath.slice(1);
const authoredLine=helper.split('\n').findIndex(line=>line.includes('WORKER_SOURCE_MAP_AUTHOR_THROW'))+1;
const authoredColumn=helper.split('\n')[authoredLine-1].indexOf('new Error')+1;
const expectedLocation=helperUri+':'+authoredLine+':'+authoredColumn;
const producerInputs={script:createHash('sha256').update(await fs.readFile(new URL(import.meta.url))).digest('hex'),harness:createHash('sha256').update(await fs.readFile(new URL('./browser-product-harness.mjs',import.meta.url))).digest('hex'),fixture:createHash('sha256').update(helper).digest('hex')};
const output=process.env.PLAYGROUND_SOURCE_MAP_REPORT;
const checks=[],cases=[];let harness,report;
const native=`import {Node2D} from 'godot';
import {throwAuthoredSourceError} from './nested/WorkerSourceMapCrash';
const J:any=require('godot-jsb');
export default class Main extends Node2D {
 frames=0;
 _process(){if(++this.frames!==20)return;try{throwAuthoredSourceError();}catch(error){
  const host=(globalThis as any).__godotjsRuntimeHost,raw=String((error as Error).stack);
  host.emitProjectEvent({type:'worker-source-map',documentAbsent:typeof (globalThis as any).document==='undefined',role:host.role,raw,mapped:J.internal.react.formatStack(raw)});
 }}
}`;
function project(runtime,source){const entry=runtime==='react'?'/src/App.tsx':'/src/Main.ts';return {schemaVersion:3,engineProfile:harness.release.runtimeProfile,runtime,demoId:runtime==='react'?'react':'native',entry,selected:entry,mode:'production',controls:{},files:{[entry]:source,[helperPath]:helper,'/project.godot':'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',...(runtime==='godot'?{'/main.tscn':'[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://src/Main.ts" id="1"]\n[node name="Main" type="Node2D"]\nscript=ExtResource("1")\n'}:{})}};}
async function compiled(project){
 const record=await harness.until(async()=>{const records=(await harness.observation()).compilations;const value=records.find(item=>item.complete&&item.sources['res://'+project.entry.slice(1)]===project.files[project.entry]);if(value?.error)throw Error(value.error);return value;},'The exact production PCK and source map were not observed');
 assert.equal(record.manifest.engineReleaseId,harness.release.id);assert.equal(record.manifest.engineId,harness.release.engineId);
 const map=record.maps.find(item=>{const parsed=JSON.parse(item.content);return parsed.sources?.includes(helperUri);});assert(map,'The actual PCK must contain the authored helper source map');
 const parsed=JSON.parse(map.content),index=parsed.sources.indexOf(helperUri);assert.equal(parsed.version,3);assert(parsed.mappings.length);assert.equal(parsed.sourcesContent[index],helper);
 assert.equal(record.sources[helperUri],helper);assert.match(record.packSha256,/^[a-f0-9]{64}$/);
 assert.equal(record.artifactReceipt?.schemaVersion,2);assert.equal(record.artifactReceipt.buildKey,record.manifest.buildKey);assert.equal(record.artifactReceipt.packSha256,record.packSha256);assert.match(record.artifactReceipt.artifactId,/^[a-f0-9]{64}$/);assert.equal(record.artifactReceipt.artifactId,record.manifest.artifactId);
 return {packSha256:record.packSha256,buildKey:record.manifest.buildKey,artifactReceipt:record.artifactReceipt,map:{file:map.file,sha256:map.sha256,sources:parsed.sources,authoredSourceSha256:createHash('sha256').update(helper).digest('hex')}};
}
try{
 harness=await openProductHarness();
 const caught=project('godot',native);await harness.importProject(caught);await harness.waitRunning();
 const event=await harness.until(async()=>{const observation=await harness.observation();return observation.telemetry.find(item=>item.type==='project'&&item.data?.type==='worker-source-map')?.data;},'The real engine Worker did not report its authored stack');
 assert.equal(event.documentAbsent,true);assert.equal(event.role,'engine');assert.match(event.raw,/res:\/\/[^\s()@]+WorkerSourceMapCrash\.js:\d+:\d+/);assert(event.mapped.includes(expectedLocation),JSON.stringify({expectedLocation,...event}));
 const caughtArtifact=await compiled(caught),caughtExit=await harness.stop();cases.push({name:'native-caught',expectedLocation,...event,artifact:caughtArtifact,terminal:caughtExit});checks.push('The actual browser compiler PCK preserves authored TSX and its map; a caught Worker stack maps to the exact file, line and column');
 for(const kind of ['render','commit','frame']){
  const body=kind==='render'?'throwAuthoredSourceError();':kind==='commit'?'React.useLayoutEffect(()=>throwAuthoredSourceError(),[]);':'useFrame("process",()=>throwAuthoredSourceError());';
  const source=`import React from 'react';\nimport {EngineNode,useFrame} from '@godot-js/react/engine';\nimport {Label} from 'godot';\nimport {throwAuthoredSourceError} from './nested/WorkerSourceMapCrash';\nexport default function App(){${body}return <EngineNode ctor={Label}/>;}\n`;
  const authored=project('react',source);await harness.importProject(authored);
  const terminal=await harness.until(async()=>{const value=(await harness.observation()).telemetry.find(item=>item.type==='fatal');if(value)return value;const state=await harness.inspect();if(state?.diagnostics?.some(item=>item.category==='error'))throw Error(JSON.stringify(state.diagnostics));},'The '+kind+' failure did not reach the real preview protocol');
  assert.match(terminal.text,/WORKER_SOURCE_MAP_AUTHOR_THROW/);assert(terminal.diagnostic?.stack?.includes(expectedLocation),JSON.stringify({expectedLocation,terminal}));assert.equal(terminal.diagnostic.source,'godotjs');assertProductCleanup(terminal.cleanup,'forced');
  await harness.until(async()=>await harness.page.locator('#preview iframe').count()===0,'The failed preview was not retired');
  const logs=await harness.page.locator('#logs').textContent();assert(logs.includes(expectedLocation),'The editor must show the exact authored location');
  cases.push({name:'react-'+kind,expectedLocation,diagnostic:terminal.diagnostic,cleanup:terminal.cleanup,artifact:await compiled(authored)});checks.push(kind+' failure traverses Worker RuntimeHost, PreviewRunner and the editor with the exact authored source location and complete cleanup');
 }
 assert.deepEqual(harness.pageErrors,[]);report=await harness.report({status:'passed',scope:'exact-candidate-formal-worker-source-maps',engineExecuted:true,producerInputs,producerHash:createHash('sha256').update(JSON.stringify(producerInputs)).digest('hex'),authoredLine,authoredColumn,expectedLocation,checks,cases,pageErrors:harness.pageErrors});
}catch(error){report={status:'failed',scope:'exact-candidate-formal-worker-source-maps',error:String(error),stack:error.stack,expectedLocation,checks,cases,...(harness?{candidateId:harness.candidateId,state:await harness.inspect().catch(()=>undefined),logs:await harness.page.locator('#logs').textContent().catch(()=>undefined)}:{})};process.exitCode=1;}
finally{if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}console.log(JSON.stringify(report,null,2));await harness?.close();}

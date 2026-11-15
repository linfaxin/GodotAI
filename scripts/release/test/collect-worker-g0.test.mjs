import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {collectWorkerG0} from '../collect-worker-g0.mjs';
import {engineBuildArgs,getEngineProfile} from '../engine-profiles.mjs';
import {canonicalIdentityJson} from '../release-identities.mjs';
import {packageBrowserEngineArtifact} from '../../test/package-browser-engine-artifact.mjs';
import {validateG0Receipt} from '../g0-readiness.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
/** Synthetic normalizer fixture, not browser runtime evidence. */
async function fixture(t){
 const root=await mkdtemp(resolve(tmpdir(),'worker-g0-normalizer-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=async(name,contents)=>{const target=resolve(root,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,contents);return target;};
 const javascript='synthetic engine main',wasm=Buffer.from([0,97,115,109,1,0,0,0]);
 await file('template.zip','synthetic archive');await file('run/site/engine/godot.js',javascript);await file('run/site/engine/godot.wasm',wasm);
 const source={commit:'a'.repeat(40),inputs:{'fixture.cpp':sha('synthetic source')}};source.snapshotHash=sha(canonicalIdentityJson(source.inputs));
 const definition=getEngineProfile('full-engine-v1'),recipe={command:'synthetic-scons',args:engineBuildArgs({executionModel:'proxy-pthread'})};
 const assets=[{path:'godot.js',sha256:sha(javascript),bytes:Buffer.byteLength(javascript)},{path:'godot.wasm',sha256:sha(wasm),bytes:wasm.length}];
 const execution={schemaVersion:1,executionModel:'proxy-pthread',wasmThreads:true,proxyToPthread:true,requiresCrossOriginIsolation:true,hostProtocolVersion:1,workerBootstrap:'embedded',workerAssets:[{...assets[0],role:'pthread-runtime',embedded:true}]};
 const build={schemaVersion:1,kind:'godot-js-browser-engine-build',status:'built',sourceCertified:true,source,godotSource:{...source,commit:'b'.repeat(40)},recipe,recipeSha256:sha(canonicalIdentityJson(recipe)),builder:{sha256:sha('synthetic builder')},toolchains:{emscripten:'synthetic'},versionEvidence:{sha256:sha('synthetic version')},runtimeProfile:'full-engine-v1',modules:[...definition.modules],resolvedFeatures:definition.features,resolvedBuildOptions:{...definition.features,threads:true,proxy_to_pthread:true,dlink_enabled:false},execution,template:{path:'template.zip',sha256:sha('synthetic archive'),bytes:17,assets}};
 const engineReport=await file('engine-report.json',JSON.stringify(build));
 const cleanup={workers:8,terminatedWorkers:8,errors:[],mode:'clean',audioContexts:1,closedAudioContexts:1,messagePorts:1,closedMessagePorts:1};
 const lifecycle={phase:{passed:true,sharedSession:true,commitsBefore:1,commitsDuring:1,commitsAfter:2},detached:{passed:true,aliveInRef:true,aliveInLayout:true,aliveInPassive:true,validAfterFree:false,releaseRequested:1,freed:1,pendingReleases:0},opaque:{passed:true,ownerAliveAtCleanup:true,portalAliveAtCleanup:true,pendingReleases:0}};
 const scoped={id:'session-0',status:'passed',start:{modules:build.modules.length,documentAbsent:true,role:'engine',workerSecure:true,workerIsolated:true,sab:true,syncHost:{screen:{x:800,y:600},display:'synthetic display'}},ready:{reactValue:7,collided:true,physicsFrames:4,echo:true,inputs:1,reactLifecycle:lifecycle},roles:[{role:'engine'},{role:'script-worker'}],gl:[{owner:'host',type:'webgl2'}],cleanup,audio:[{peak:.2,checks:1,state:'closed'}]};
 const producerInputs={harness:sha('synthetic harness')};
 for(const [key,name]of [['host','session.js'],['pack','project.pck'],['editorHtml','index.html'],['previewHtml','preview.html']]){const contents='synthetic '+name;await file('run/site/'+name,contents);producerInputs[key]=sha(contents);}
 const raw={kind:'godotjs-worker-integration',status:'failed',validationBatchId:'synthetic-unit-fixture',sourceSnapshotHash:source.snapshotHash,producerInputs,producerHash:sha(JSON.stringify(producerInputs)),engineReportHash:sha(await readFile(engineReport)),templateSha256:build.template.sha256,browser:{name:'chromium',version:'synthetic-test-only'},os:'synthetic-test-only',origins:{editor:'https://editor.example.test',preview:'https://preview.example.test'},launchArgs:['--ignore-certificate-errors-spki-list=synthetic-pin'],responseHeaders:{top:{'cross-origin-opener-policy':'same-origin'},preview:{'cross-origin-embedder-policy':'require-corp'}},isolation:{top:{secure:true,isolated:true,sab:true},preview:{secure:true,isolated:true,sab:true}},platformProbe:{ime:{compositionEvent:true,beforeInput:true},xr:{api:false,immersiveVR:false}},cases:[scoped],error:'Later synthetic failure'};
 const runtimeReport=await file('run/worker-integration.json',JSON.stringify(raw));
 const save=()=>file('run/worker-integration.json',JSON.stringify(raw));
 return {root,engineReport,runtimeReport,raw,scoped,cleanup,save,collect:()=>collectWorkerG0({engineReport,runtimeReport,out:resolve(root,'g0')})};
}
test('normalizer scopes explicitly passed observations while retaining a failed parent suite',async t=>{
 const f=await fixture(t),result=await f.collect();
 assert.deepEqual(result.readiness.clearedBlockers,['B1-EXEC','B2-ROUTING','B3-HOST-DEPLOY','B5-REACT-INTEGRATION']);
 assert.equal(result.readiness.defaultReleaseReady,false);
 assert.equal(result.receipt.cases.find(item=>item.id==='session-termination').status,'unverified');
 assert.equal(result.receipt.cases.find(item=>item.id==='execution-identity').status,'unverified');
 const scoped=JSON.parse(await readFile(resolve(result.directory,'cases/isolated-host.json')));
 assert(scoped.limitations.some(text=>text.includes('OS composition')));
 assert(scoped.limitations.some(text=>text.includes('parent suite did not pass')));
});
test('normalizer never extracts a success from an error message or a failed scoped case',async t=>{
 const f=await fixture(t);f.raw.error=JSON.stringify(f.scoped);f.scoped.status='failed';await f.save();
 assert.deepEqual((await f.collect()).readiness.clearedBlockers,[]);
});
test('stale producer provenance stays unverified and changed runtime assets fail closed',async t=>{
 const f=await fixture(t);f.raw.producerInputs.harness=sha('changed producer');await f.save();
 assert.deepEqual((await f.collect()).readiness.clearedBlockers,[]);
 await writeFile(resolve(f.root,'run/site/engine/godot.js'),'changed JS');
 await assert.rejects(f.collect(),/differs from sealed template/);
});
test('termination requires actual hang, host progress, whole pool, ports and successful fresh restart',async t=>{
 const f=await fixture(t);f.raw.status='passed';f.scoped.cleanup={...f.cleanup,mode:'forced'};f.scoped.termination={engineHung:true,hostResponsive:true};f.scoped.staleSessionRejected=true;f.raw.afterForcedRestart={...f.cleanup};await f.save();
 assert((await f.collect()).readiness.clearedBlockers.includes('B4-SESSION'));
 delete f.scoped.termination;await f.save();assert(!(await f.collect()).readiness.clearedBlockers.includes('B4-SESSION'));
});
test('identity suite accepts a portable report only through its verified original-byte mapping',async t=>{
 const f=await fixture(t),portable=resolve(f.root,'portable');
 await packageBrowserEngineArtifact({report:f.engineReport,out:portable});
 const source='packages/engine/src/identities.ts',inputs={[source]:sha(await readFile(new URL('../../../'+source,import.meta.url)))};
 const log='Synthetic Node test adapter fixture, not browser evidence\n';await writeFile(resolve(f.root,'unit.log'),log);
 const suite={kind:'w5-implementation-validation',status:'passed',tests:{passed:1,failed:0,report:'unit.log',reportSha256:sha(log)},source:{inputs,snapshotHash:sha(canonicalIdentityJson(inputs))},nativeArtifact:{reportSha256:sha(await readFile(f.engineReport))}};
 const identityReport=resolve(f.root,'unit.json');await writeFile(identityReport,JSON.stringify(suite));
 const engineReport=resolve(portable,'engine-report.json');f.raw.engineReportHash=sha(await readFile(engineReport));await f.save();
 const collect=()=>collectWorkerG0({engineReport,runtimeReport:f.runtimeReport,out:resolve(f.root,'g0'),identityReport});
 const result=await collect();assert(result.readiness.clearedBlockers.includes('B6-IDENTITY'));
 await writeFile(resolve(result.directory,'parents/unit.log'),'tampered archived unit log');
 await assert.rejects(validateG0Receipt(result.receipt,{root:result.directory}),/Parent unit log changed/);
 await writeFile(resolve(portable,'engine-report.original.json'),'changed original');
 assert(!(await collect()).readiness.clearedBlockers.includes('B6-IDENTITY'));
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createWorkerRegressionBudget,assessPerformanceBudget} from '../../../apps/playground/scripts/performance-acceptance.mjs';
import {digest,siteIdentity,performanceComparisonInputs} from '../../../apps/playground/scripts/site-evidence.mjs';
import {performanceSiteFixture} from '../../../apps/playground/scripts/fixtures/performance-site.mjs';
import {assertWorkerPerformanceEvidence} from '../../../apps/playground/scripts/worker-rollout-gates.mjs';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
const workflow=await readFile(new URL('../../../.github/workflows/browser-playground.yml',import.meta.url),'utf8');
const aggregate=workflow.match(/node --input-type=module <<'WORKER_AGGREGATE'\n([\s\S]*?)\n          WORKER_AGGREGATE/)?.[1].replace(/^          /gm,'');
const step=name=>workflow.split('      - name: '+name+'\n')[1]?.split('\n      - ')[0];

test('public rollout gate blocks the obsolete single-report performance contract',async()=>{
 await assert.rejects(assertWorkerPerformanceEvidence({},'passing-direct.json'),/Both direct and bitmap/);
 await assert.rejects(assertWorkerPerformanceEvidence({},undefined),/Both direct and bitmap/);
});

test('default Worker CI covers both profiles and native targets with honest default settings',()=>{
 assert.match(workflow,/profile: \[full-engine-v1, engine-2d-v1\]/);
 assert.match(workflow,/options: \[all, template_debug, template_release\]\n        default: all/);
 assert.match(workflow,/target: .*inputs\.engine_target != 'all'.*'\["template_debug","template_release"\]'/);
 assert(!workflow.includes("inputs.engine_target || 'template_debug'"));
 assert.match(workflow,/name: browser-conformance-candidate-\$\{\{ github.sha \}\}-\$\{\{ matrix.target \}\}/);
 const acceptance=step('Accept both explicit Worker presenters against the exact candidate');
 assert.match(acceptance,/PLAYGROUND_BROWSER_DEFAULT_SETTINGS: '1'/);
 assert.match(acceptance,/worker-acceptance-matrix\.mjs/);
 assert(!/LIBGL_ALWAYS_SOFTWARE|swiftshader|autoplay-policy/.test(acceptance));
});

test('optional performance uses an external frozen legacy site and keeps missing baselines unaccepted',()=>{
 const performance=step('Measure fixed legacy-to-Worker performance regression budgets');
 assert.match(performance,/inputs.measure_performance/);
 const legacy=performance.indexOf('--execution legacy');
 assert(legacy>=0);assert.match(performance,/--site "\$baseline_site"/);assert.doesNotMatch(performance,/--site "\$RUNNER_TEMP\/default-playground-site"[^\n]+--execution legacy/);assert.match(performance,/not-evaluated/);assert.match(workflow,/name: Download independent frozen performance baseline sites/);
 for(const presenter of ['direct','bitmap']){
  const command=performance.split('\n').find(line=>line.includes('--presentation-backend '+presenter)&&line.includes('--baseline '));
  assert(command&&performance.indexOf(command)>legacy);
  assert.match(command,/--execution worker/);
  assert.match(command,/--baseline .*browser-engine-performance\.legacy\.json/);
  assert(command.includes('--write-budget "$RUNNER_TEMP/browser-engine-budget.'+presenter+'.json"'));
  assert.match(command,/\|\| worker_performance_status=1$/);
 }
 assert.match(performance,/exit "\$worker_performance_status"/);
 assert(!/--budget\b|LIBGL_ALWAYS_SOFTWARE/.test(performance));
 assert(!step('Build the selected native product candidate').includes('--worker-execution'));
 assert.match(workflow,/performance_baseline_run_id:/);
});

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'worker-workflow-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const artifacts=path.join(root,'artifacts'),out=path.join(root,'summary.json');
 const save=async(filename,value)=>{await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,JSON.stringify(value,null,2)+'\n');};
 const run=async()=>{
  const result=spawnSync(process.execPath,['--input-type=module'],{cwd:repository,input:aggregate,encoding:'utf8',env:{...process.env,WORKER_ARTIFACT_ROOT:artifacts,WORKER_ROLLOUT_OUT:out,WORKER_BROWSER_JOB_RESULT:'success',GITHUB_STEP_SUMMARY:''}});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(await readFile(out,'utf8'));
 };
 return {root,artifacts,out,save,run};
}

test('four-target aggregate is executable and blocks empty or diagnostic-only evidence',async t=>{
 assert(aggregate,'workflow aggregate script must exist');
 const checked=spawnSync(process.execPath,['--input-type=module','--check'],{input:aggregate,encoding:'utf8'});
 assert.equal(checked.status,0,checked.stderr);
 assert.match(workflow,/rollout-summary:[\s\S]*?needs: browser\n    if: always\(\)/);
 const f=await fixture(t),result=await f.run();
 assert.equal(result.status,'blocked');assert.equal(result.engineering,'go');
 assert.equal(result.defaultSwitch,'blocked');assert.equal(result.publication,'blocked');
 assert.equal(result.automaticPublication,false);assert.equal(result.missingTargets.length,4);
});

test('aggregate accepts unchanged fixed policies for both presenters and rejects threshold edits',async t=>{
 const f=await fixture(t),directory=path.join(f.artifacts,'browser-playground-candidate-full-debug');
 const site=path.join(directory,'default-playground-site');
 await performanceSiteFixture(site);
 const {payloads,...identity}=await siteIdentity(site),comparisonInputs=await performanceComparisonInputs(site,{demos:['scene']});
 const sources=Object.fromEntries(['browser-engine-performance.mjs','performance-acceptance.mjs','browser-harness.mjs','site-evidence.mjs'].map(name=>['apps/playground/scripts/'+name,'proof']));
 const producer={schemaVersion:1,kind:'worker-performance-tool',sources};
 const parameters={demos:['scene'],samplesPerDemo:3,thresholds:'No budget'};
 const hardware={platform:'linux',arch:'x64',node:'24',kernel:'unit-kernel',cpuModels:['cpu'],logicalCPUs:2,availableParallelism:2,totalMemoryBytes:4096,cgroupCpuMax:'200000 100000',cgroupMemoryMax:'4096',loadAverageStart:[1,1,1],loadAverageEnd:[2,2,2]};
 const baseline={schemaVersion:2,kind:'godotjs-browser-engine-performance',measurementStatus:'completed',measurementBatchId:'baseline-batch',identity:{...identity,releaseId:digest('historical release'),descriptorHash:digest('historical descriptor'),candidateId:digest('historical baseline'),siteHash:digest('historical site')},comparisonInputs,producer,parameters,hardware,measurementScope:{profile:identity.profile,executionBackend:'legacy',presentationBackend:'legacy',browser:'chromium',settingsTier:'default'},engine:{templateTarget:'template_debug'},scenarios:[{browser:{name:'chromium',version:'154',settingsTier:'default'}}],summary:{demos:{scene:{navigationToRunningMs:{p95:100},wasmMemoryCapacityPeakBytes:{max:1000},stopMs:{max:100},perSampleMedianTelemetryFPS:{median:60}}}}};
 await f.save(path.join(directory,'default-playground-results/site-acceptance.json'),{...identity,testSources:sources});
 const baselinePath=path.join(directory,'browser-engine-performance.legacy.json');await f.save(baselinePath,baseline);
 const baselineSha256=digest(await readFile(baselinePath));
 let directBudget;
 for(const presentationBackend of ['direct','bitmap']){
  const budget=createWorkerRegressionBudget(baseline,{baselineSha256,presentationBackend});
  const report={...baseline,identity,measurementScope:budget.scope,parameters:{...parameters,thresholds:{budgetId:budget.id}},hardware:{...hardware,loadAverageStart:[3,3,3],loadAverageEnd:[4,4,4]}};
  report.performanceAcceptance=assessPerformanceBudget(report,budget);
  await f.save(path.join(directory,'browser-engine-budget.'+presentationBackend+'.json'),budget);
  await f.save(path.join(directory,'browser-engine-performance.worker-'+presentationBackend+'.json'),report);
  if(presentationBackend==='direct')directBudget=budget;
 }
 const valid=await f.run();
 assert.equal(valid.artifacts[0].key,'full-engine-v1:template_debug');
 assert.equal(valid.artifacts[0].status,'evidence-collected');
 assert.equal(valid.artifacts[0].performance.bitmap.status,'passed');
 assert.equal(valid.status,'blocked','unsealed fixtures cannot authorize rollout');
 // Material and provenance are independent: this baseline has a different
 // release/descriptor identity, while the actual current site stays bound.
 assert.notEqual(baseline.identity.releaseId,identity.releaseId);
 const directFile=path.join(directory,'browser-engine-performance.worker-direct.json'),originalDirect=JSON.parse(await readFile(directFile));
 for(const [name,change,pattern]of [
  ['material',value=>{value.comparisonInputs.sdk.sourceSnapshotHash=digest('different SDK');},/E_PERFORMANCE_BASELINE_MATERIAL/],
  ['candidate',value=>{value.identity.candidateId=digest('other candidate');},/Performance identity differs/],
  ['producer',value=>{value.producer.sources['apps/playground/scripts/site-evidence.mjs']='old-tool';},/Performance tool sources differ/],
  ['hardware',value=>{value.hardware.logicalCPUs++;},/Performance hardware differs/],
  ['parameters',value=>{value.parameters.samplesPerDemo++;},/Performance parameters differ/],
  ['browser version',value=>{value.scenarios[0].browser.version='other-build';},/browser version differs/],
 ]){
  const altered=structuredClone(originalDirect);change(altered);await f.save(directFile,altered);
  const rejected=await f.run();assert.equal(rejected.artifacts[0].status,'blocked',name);assert.match(rejected.artifacts[0].failure,pattern,name);
 }
 await f.save(directFile,originalDirect);
 directBudget.metrics[0].value=999999;
 await f.save(path.join(directory,'browser-engine-budget.direct.json'),directBudget);
 const altered=await f.run();
 assert.equal(altered.artifacts[0].status,'blocked');
 assert.match(altered.artifacts[0].failure,/Fixed regression budget differs: direct/);
 assert.equal(altered.publication,'blocked');
 // A direct pass cannot hide the exact C10 failure mode: bitmap FPS below its fixed baseline-derived threshold.
 await f.save(path.join(directory,'browser-engine-budget.direct.json'),createWorkerRegressionBudget(baseline,{baselineSha256,presentationBackend:'direct'}));
 const bitmapFile=path.join(directory,'browser-engine-performance.worker-bitmap.json'),bitmap=JSON.parse(await readFile(bitmapFile,'utf8'));
 bitmap.summary.demos.scene.perSampleMedianTelemetryFPS.median=7;
 await f.save(bitmapFile,bitmap);
 const bitmapFailed=await f.run();
 assert.match(bitmapFailed.artifacts[0].failure,/Fixed Worker regression budget failed: bitmap/);
 assert.equal(bitmapFailed.defaultSwitch,'blocked');
});

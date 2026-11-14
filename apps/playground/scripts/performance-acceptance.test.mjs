import test from 'node:test';
import assert from 'node:assert/strict';
import {assessPerformanceBudget,createWorkerRegressionBudget} from './performance-acceptance.mjs';
test('observational completion never implies budget acceptance and unavailable measurements cannot pass',()=>{
 const scope={profile:'full-engine-v1',executionBackend:'worker',presentationBackend:'direct',browser:'chromium',settingsTier:'default'};
 const report={measurementStatus:'completed',measurementScope:scope,summary:{startup:{p95:1200},workerHeap:null}};
 assert.equal(assessPerformanceBudget(report).status,'not-evaluated');
 const budget={schemaVersion:1,id:'startup-v1',scope,metrics:[{path:'startup.p95',operator:'max',value:1300}]};
 assert.equal(assessPerformanceBudget(report,budget).status,'passed');
 assert.equal(assessPerformanceBudget(report,{...budget,metrics:[{path:'workerHeap',operator:'max',value:999999999}]}).status,'failed');
 assert.equal(assessPerformanceBudget(report,{...budget,metrics:[{path:'startup.p95',operator:'max',value:1100}]}).status,'failed');
 assert.throws(()=>assessPerformanceBudget(report,{...budget,scope:{...scope,presentationBackend:'bitmap'}}),/E_PERFORMANCE_BUDGET: scope/);
});
test('regression budget is fixed from a legacy baseline before Worker measurement and rejects missing metrics',()=>{
 const baseline={schemaVersion:2,kind:'godotjs-browser-engine-performance',measurementStatus:'completed',measurementBatchId:'baseline-batch',identity:{candidateId:'same-candidate'},measurementScope:{profile:'full-engine-v1',executionBackend:'legacy',presentationBackend:'legacy',browser:'chromium',settingsTier:'default'},parameters:{demos:['shader']},scenarios:[{browser:{version:'pinned-browser'}}],summary:{demos:{shader:{navigationToRunningMs:{p95:1000},wasmMemoryCapacityPeakBytes:{max:1000000},stopMs:{max:80},perSampleMedianTelemetryFPS:{median:60}}}}};
 const budget=createWorkerRegressionBudget(baseline,{baselineSha256:'a'.repeat(64),presentationBackend:'bitmap'});
 assert.equal(budget.policy,'worker-regression-v1');assert.equal(budget.baseline.sha256,'a'.repeat(64));assert.equal(budget.scope.executionBackend,'worker');assert.equal(budget.scope.presentationBackend,'bitmap');
 assert.deepEqual(budget.metrics.map(rule=>rule.value),[1100,1150000,3000,57]);
 assert.deepEqual(createWorkerRegressionBudget(baseline,{baselineSha256:'a'.repeat(64),presentationBackend:'bitmap'}),budget);
 for(const change of [value=>{value.summary.demos.shader.wasmMemoryCapacityPeakBytes.max=null;},value=>{value.summary.demos.shader.perSampleMedianTelemetryFPS.median=0;},value=>{value.measurementScope.executionBackend='worker';},value=>{value.measurementStatus='failed';}]){
  const value=structuredClone(baseline);change(value);assert.throws(()=>createWorkerRegressionBudget(value,{baselineSha256:'a'.repeat(64)}),/E_PERFORMANCE_BASELINE/);
 }
});

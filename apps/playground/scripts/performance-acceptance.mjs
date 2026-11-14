/** Measuring successfully is independent of meeting a product performance
 * budget. A versioned budget is scoped to the actual browser/configuration. */
export function assessPerformanceBudget(report,budget){
 if(!budget)return {status:'not-evaluated',reason:'No versioned performance budget supplied.'};
 const fail=detail=>{throw Error('E_PERFORMANCE_BUDGET: '+detail);};
 if(budget.schemaVersion!==1||typeof budget.id!=='string'||!budget.id||!Array.isArray(budget.metrics)||!budget.metrics.length)fail('schema');
 for(const key of ['profile','executionBackend','presentationBackend','browser','settingsTier'])if(budget.scope?.[key]!==report.measurementScope?.[key])fail('scope '+key);
 if(budget.baseline?.browserVersion&&report.scenarios?.some(sample=>sample.browser?.version!==budget.baseline.browserVersion))fail('browser version differs from baseline');
 const seen=new Set(),checks=[];
 for(const rule of budget.metrics){
  if(typeof rule.path!=='string'||!rule.path||seen.has(rule.path)||!['max','min'].includes(rule.operator)||!Number.isFinite(rule.value))fail('metric rule');
  seen.add(rule.path);
  const actual=rule.path.split('.').reduce((value,key)=>value&&Object.hasOwn(value,key)?value[key]:undefined,report.summary);
  checks.push({path:rule.path,operator:rule.operator,limit:rule.value,actual:Number.isFinite(actual)?actual:null,status:Number.isFinite(actual)&&(rule.operator==='max'?actual<=rule.value:actual>=rule.value)?'passed':'failed'});
 }
 return {status:checks.every(check=>check.status==='passed')?'passed':'failed',budgetId:budget.id,policy:budget.policy??'custom-v1',baseline:budget.baseline??null,scope:budget.scope,checks};
}

/** Fixed engineering regression policy, generated before Worker measurement.
 * Product SLOs may add stricter independent rules; they do not retune this one. */
export function createWorkerRegressionBudget(baseline,{baselineSha256,presentationBackend='direct'}={}){
 const fail=detail=>{throw Error('E_PERFORMANCE_BASELINE: '+detail);};
 if(!/^[a-f0-9]{64}$/.test(baselineSha256)||baseline?.schemaVersion!==2||baseline.kind!=='godotjs-browser-engine-performance'||baseline.measurementStatus!=='completed'||baseline.measurementScope?.executionBackend!=='legacy'||!['direct','bitmap'].includes(presentationBackend))fail('identity/status');
 const demos=baseline.parameters?.demos;if(!Array.isArray(demos)||!demos.length||new Set(demos).size!==demos.length)fail('scenario list');
 const browserVersions=new Set(baseline.scenarios?.map(sample=>sample.browser?.version));if(browserVersions.size!==1||!String([...browserVersions][0]??''))fail('browser build');
 const metrics=[];
 const metric=(demo,name,stat)=>{const value=baseline.summary?.demos?.[demo]?.[name]?.[stat];if(!Number.isFinite(value)||value<=0)fail('missing/nonpositive metric '+[demo,name,stat].join('.'));return value;};
 for(const demo of demos){
  if(typeof demo!=='string'||!/^[-a-z0-9]+$/.test(demo))fail('scenario id');
  metric(demo,'stopMs','max');
  metrics.push(
   {path:'demos.'+demo+'.navigationToRunningMs.p95',operator:'max',value:metric(demo,'navigationToRunningMs','p95')*1.10},
   {path:'demos.'+demo+'.wasmMemoryCapacityPeakBytes.max',operator:'max',value:metric(demo,'wasmMemoryCapacityPeakBytes','max')*1.15},
   {path:'demos.'+demo+'.stopMs.max',operator:'max',value:3000},
   {path:'demos.'+demo+'.perSampleMedianTelemetryFPS.median',operator:'min',value:metric(demo,'perSampleMedianTelemetryFPS','median')*0.95},
  );
 }
 const scope={...baseline.measurementScope,executionBackend:'worker',presentationBackend};
 return {schemaVersion:1,id:['worker-regression-v1',scope.profile,scope.browser,presentationBackend,baselineSha256].join('/'),policy:'worker-regression-v1',scope,baseline:{sha256:baselineSha256,identity:baseline.identity,comparisonInputs:baseline.comparisonInputs,browserVersion:[...browserVersions][0],measurementBatchId:baseline.measurementBatchId,parameters:baseline.parameters,hardware:baseline.hardware,producer:baseline.producer},metrics};
}

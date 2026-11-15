#!/usr/bin/env node
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sealSiteAcceptance} from './seal-site-acceptance.mjs';
import {assessWorkerCapabilityEvidence,assertOriginalPlatformProbeReport,assertWorkerCapabilityProbeReport} from './worker-capability-ledger.mjs';
import {digest,canonical,siteIdentity,performanceComparisonInputs,assertPerformanceComparable} from './site-evidence.mjs';
import {createWorkerRegressionBudget,assessPerformanceBudget} from './performance-acceptance.mjs';

const json=async filename=>JSON.parse(await readFile(filename,'utf8'));
/** The public gate requires both explicit presenters against one immutable
 * legacy baseline. A passing direct report alone cannot authorize rollout. */
export async function assertWorkerPerformanceEvidence(receipt,configuration,{target,site}={}){
 if(!configuration||typeof configuration!=='object'||Array.isArray(configuration)||typeof configuration.baseline!=='string')throw Error('Both direct and bitmap performance reports/budgets and one legacy baseline are required; single-report evidence is blocked.');
 const baselineBytes=await readFile(path.resolve(configuration.baseline)),baseline=JSON.parse(baselineBytes);
 if(baseline.measurementScope?.settingsTier!=='default'||baseline.measurementScope?.profile!==receipt.profile||baseline.measurementScope?.presentationBackend!=='legacy')throw Error('Legacy performance baseline scope differs.');
 if(!site)throw Error('Performance evidence requires the actual candidate site.');
 const actualIdentity=await siteIdentity(site);
 for(const field of ['profile','releaseId','descriptorHash','candidateId','siteHash'])if(actualIdentity[field]!==receipt[field])throw Error('Performance candidate site differs: '+field);
 const comparisonInputs=await performanceComparisonInputs(site,{demos:baseline.parameters?.demos});
 assertPerformanceComparable(baseline.comparisonInputs,comparisonInputs);
 const hardwareKeys=['platform','arch','node','kernel','cpuModels','logicalCPUs','availableParallelism','totalMemoryBytes','cgroupCpuMax','cgroupMemoryMax'];
 const results={};
 for(const presentationBackend of ['direct','bitmap']){
  const artifact=configuration[presentationBackend];if(typeof artifact?.report!=='string'||typeof artifact.budget!=='string')throw Error('Missing performance report/budget: '+presentationBackend);
  const report=await json(path.resolve(artifact.report)),budget=await json(path.resolve(artifact.budget));
  const expected=createWorkerRegressionBudget(baseline,{baselineSha256:digest(baselineBytes),presentationBackend});
  if(canonical(budget)!==canonical(expected))throw Error('Fixed regression budget differs: '+presentationBackend);
  assertPerformanceComparable(report.comparisonInputs,comparisonInputs);
  for(const field of ['profile','releaseId','descriptorHash','candidateId','siteHash'])if(report.identity?.[field]!==receipt[field])throw Error('Performance identity differs: '+presentationBackend+'/'+field);
  if(target!==undefined&&(baseline.engine?.templateTarget!==target||report.engine?.templateTarget!==target))throw Error('Performance native target differs: '+presentationBackend);
  const producer=report.producer;
  if(canonical(producer)!==canonical(baseline.producer)||producer?.schemaVersion!==1||producer.kind!=='worker-performance-tool'||!['browser-engine-performance.mjs','performance-acceptance.mjs','browser-harness.mjs','site-evidence.mjs'].every(name=>producer.sources?.['apps/playground/scripts/'+name]===receipt.testSources?.['apps/playground/scripts/'+name]))throw Error('Performance tool sources differ from accepted batch: '+presentationBackend);
  const {thresholds:workerThresholds,...workerParameters}=report.parameters??{}, {thresholds:baselineThresholds,...baselineParameters}=baseline.parameters??{};
  if(canonical(workerParameters)!==canonical(baselineParameters))throw Error('Performance parameters differ: '+presentationBackend);
  for(const field of hardwareKeys){if(!Object.hasOwn(baseline.hardware??{},field)||!Object.hasOwn(report.hardware??{},field))throw Error('Performance hardware unavailable: '+presentationBackend+'/'+field);if(canonical(report.hardware[field])!==canonical(baseline.hardware[field]))throw Error('Performance hardware differs: '+presentationBackend+'/'+field);}
  if(report.measurementScope?.settingsTier!=='default'||report.measurementScope?.profile!==receipt.profile||report.measurementScope?.executionBackend!=='worker'||report.measurementScope?.presentationBackend!==presentationBackend)throw Error('Performance scope differs: '+presentationBackend);
  for(const measured of [baseline,report])if(!measured.scenarios?.length||measured.scenarios.some(sample=>sample.browser?.settingsTier!=='default'||sample.browser?.name!==measured.measurementScope.browser))throw Error('Performance sample browser scope differs: '+presentationBackend);
  const assessed=assessPerformanceBudget(report,budget);
  if(report.measurementStatus!=='completed'||assessed.status!=='passed'||canonical(report.performanceAcceptance)!==canonical(assessed))throw Error('Fixed Worker regression budget failed: '+presentationBackend);
  results[presentationBackend]={status:'passed',budgetId:budget.id,baselineSha256:digest(baselineBytes)};
 }
 return results;
}
/** Default rollout and publication are distinct from allowing engineering
 * work. Every declared product target must have its own immutable evidence. */
export async function assessWorkerRollout(configuration){
 const result={schemaVersion:1,engineering:'go',productExecutionBackend:'worker',legacyExecutionAvailable:false,defaultSwitch:'blocked',publication:'blocked',candidates:[],failures:[]},seen=new Set();
 for(const candidate of configuration?.candidates??[]){
  const entry={site:path.resolve(candidate.site),status:'blocked',failures:[]};result.candidates.push(entry);
  try{
   const reports=path.resolve(candidate.reports),manifest=await json(path.join(entry.site,'manifest.json'));
   await sealSiteAcceptance(entry.site,reports,{verify:true});
   const receipt=await json(path.join(reports,'site-acceptance.json')),key=receipt.profile+':'+manifest.engineTarget;
   if(seen.has(key))throw Error('Duplicate profile/target candidate '+key);seen.add(key);entry.key=key;
   const capabilities=await json(path.resolve(candidate.capabilities)),assessed=assessWorkerCapabilityEvidence(receipt,capabilities);entry.failures.push(...assessed.failures);
   const cachedEvidence=new Map();
   const readEvidence=async asset=>{
    if(typeof asset.path!=='string'||asset.path.startsWith('/')||asset.path.includes('\\')||asset.path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Unsafe capability evidence path');
    let bytes=cachedEvidence.get(asset.path);if(!bytes){bytes=await readFile(path.join(reports,asset.path));cachedEvidence.set(asset.path,bytes);}if(digest(bytes)!==asset.sha256||(asset.bytes!==undefined&&bytes.length!==asset.bytes))throw Error('Capability evidence bytes changed: '+asset.path);return bytes;
   };
   for(const item of capabilities.cases??[]){
    if(item.status!=='passed')continue; // A blocked case supplies no passing probe to authorize rollout.
    for(const asset of item.evidence??[])await readEvidence(asset);
    assertWorkerCapabilityProbeReport(receipt,item,JSON.parse(await readEvidence(item.probe)));
    if(item.classification==='original-platform-unsupported')assertOriginalPlatformProbeReport(receipt,item,JSON.parse(await readEvidence(item.baseline.probe)));
    if(item.classification==='versioned-change')await readEvidence(item.change.documentation);
   }
   entry.performance=await assertWorkerPerformanceEvidence(receipt,candidate.performance,{target:manifest.engineTarget,site:entry.site});
   entry.status=entry.failures.length?'blocked':'passed';
  }catch(error){entry.failures.push(String(error.message??error));}
  result.failures.push(...entry.failures.map(message=>(entry.key??entry.site)+': '+message));
 }
 for(const profile of ['full-engine-v1','engine-2d-v1'])for(const target of ['template_debug','template_release'])if(!seen.has(profile+':'+target))result.failures.push('Missing supported target: '+profile+':'+target);
 if(!result.failures.length){result.defaultSwitch='go';result.publication='ready-for-delivery-verification';}
 return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
 try{
  if(!option('--configuration'))throw Error('Usage: worker-rollout-gates.mjs --configuration JSON [--out JSON]');
  const result=await assessWorkerRollout(await json(path.resolve(option('--configuration'))));
  if(option('--out')){const output=path.resolve(option('--out'));await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');}
  console.log(JSON.stringify(result,null,2));if(result.defaultSwitch!=='go')process.exitCode=1;
 }catch(error){console.error(error.stack??error);process.exitCode=1;}
}

import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {siteIdentity,sitePayloads,digest,canonical} from './site-evidence.mjs';

export async function launchBrowser(options={}){
 const name=options.browser??process.env.BROWSER??'chromium';
 if(!['chromium','firefox','webkit'].includes(name))throw Error('E_BROWSER: '+name);
 const playwright=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
 const {args,executablePath,browser:ignored,...shared}=options;
 const configured=process.env['PLAYWRIGHT_'+name.toUpperCase()+'_EXECUTABLE'];
 const executable=configured||(name==='chromium'?(executablePath??(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined)):undefined);
 return playwright[name].launch({...shared,headless:process.env.BROWSER_HEADLESS==='0'?false:(shared.headless??true),...(executable?{executablePath:executable}:{}),...(name==='chromium'&&args?{args}:{})});
}
export const launchTestBrowser=launchBrowser;

/** Reports bind the actual bytes under test, never just a recent timestamp. */
export async function withAcceptanceContext(report,{directory,browser,testMode='real-engine',contextFile=process.env.PLAYGROUND_ACCEPTANCE_CONTEXT}={}){
 if(testMode==='shell'){
  if(contextFile)throw Error('E_TEST_SHELL_PRODUCT_CONTEXT');
  const shell=JSON.parse(await readFile(path.join(directory,'shell-profile.json'),'utf8'));
  if(shell.shellOnly!==true)throw Error('E_TEST_SHELL_FIXTURE');
  const siteHash=digest(canonical(await sitePayloads(directory)));
  return {...report,profile:shell.runtimeProfile,releaseId:null,descriptorHash:null,candidateId:siteHash,siteHash,runId:randomUUID(),testMode:'shell',browser:{name:browser.browserType().name(),version:browser.version()}};
 }
 if(testMode!=='real-engine')throw Error('E_TEST_MODE');
 const actual=await siteIdentity(directory);
 let expected;
 if(contextFile){
  expected=JSON.parse(await readFile(contextFile,'utf8'));
  for(const key of ['profile','releaseId','descriptorHash','candidateId','siteHash'])if(expected[key]!==actual[key])throw Error('E_TEST_CANDIDATE_DRIFT: '+key);
  if(typeof expected.runId!=='string'||!expected.runId)throw Error('E_TEST_RUN_ID');
 }
 for(const key of ['profile','releaseId','descriptorHash','candidateId','siteHash'])if(report[key]!==undefined&&report[key]!==actual[key])throw Error('E_TEST_RELEASE_ID: '+key);
 const {payloads,...identity}=actual;
 return {...report,...identity,runId:expected?.runId??randomUUID(),testMode,browser:{name:browser.browserType().name(),version:browser.version()}};
}

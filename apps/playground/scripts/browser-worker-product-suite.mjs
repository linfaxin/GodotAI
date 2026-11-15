import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {siteIdentity} from './site-evidence.mjs';
import {assertRuntimeEvidence} from './runtime-evidence.mjs';

const repository=fileURLToPath(new URL('../../../',import.meta.url)),option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const directory=path.resolve(option('--directory')??process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const out=path.resolve(option('--out')??'/tmp/godotjs-worker-product-suite'),browser=option('--browser')??process.env.BROWSER??'chromium';
const previous=option('--previous'),loops=Number(option('--loops')??(browser==='chromium'?100:2));
assert(['chromium','firefox','webkit'].includes(browser));await fs.mkdir(out,{recursive:true});
const identity=await siteIdentity(directory),release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
delete identity.payloads;
const report={schemaVersion:1,kind:'godotjs-formal-worker-product-suite',status:'running',...identity,browser,loops,checks:[],scope:'Actual sealed candidate: production compiler, verified loader, capability guard, RuntimeHost and PreviewRunner',externalCdn:false};
function run(script,environment,log){return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[script],{cwd:repository,env:{...process.env,BROWSER:browser,PLAYGROUND_TEST_DIRECTORY:directory,PLAYGROUND_TEST_TLS:browser==='chromium'?'1':'0',...environment},stdio:['ignore','pipe','pipe']});
 const chunks=[];for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{chunks.push(chunk);process.stderr.write(chunk);});
 child.once('error',reject);child.once('exit',async(code,signal)=>{try{await fs.writeFile(log,Buffer.concat(chunks));if(code===0)resolve();else reject(Error(script+' failed: '+(signal??code)));}catch(error){reject(error);}});
});}
async function check(name,script,variable,environment={}){
 const output=path.join(out,name+'.json');await run('apps/playground/scripts/'+script,{[variable]:output,...environment},path.join(out,name+'.browser.log'));
 const bytes=await fs.readFile(output),result=JSON.parse(bytes);assert.equal(result.status,'passed',name);assert.equal(result.candidateId,identity.candidateId,name+' must use the exact candidate');
 if(name==='runtime')assertRuntimeEvidence(result,release);
 report.checks.push({name,status:'passed',report:output,sha256:createHash('sha256').update(bytes).digest('hex'),candidateId:result.candidateId});
}
try{
 if(browser==='webkit'){
  await check('unsupported-guard','browser-worker-unsupported-test.mjs','PLAYGROUND_UNSUPPORTED_REPORT');report.status='unsupported';report.workerExecutionSupported=false;report.blocker='WK-01';process.exitCode=1;
 }else{
  await check('runtime','browser-pthread-full-engine-test.mjs','PLAYGROUND_FULL_ENGINE_REPORT',{PLAYGROUND_FULL_ENGINE_LOOPS:String(loops)});
  await check('source-maps','browser-worker-source-map-test.mjs','PLAYGROUND_SOURCE_MAP_REPORT');
  await check('raw-native-signal','browser-worker-release-barrier-test.mjs','PLAYGROUND_RELEASE_BARRIER_REPORT');
  await check('schema4','browser-schema4-flow-test.mjs','PLAYGROUND_SCHEMA4_REPORT');
  await check('resource-converters','browser-resource-converters-test.mjs','PLAYGROUND_RESOURCE_REPORT');
  await check('optional-react','browser-optional-react-network-test.mjs','PLAYGROUND_OPTIONAL_REACT_REPORT');
  if(previous){const output=path.join(out,'rollback.json');await run('apps/playground/scripts/browser-release-rollback-test.mjs',{PLAYGROUND_ROLLBACK_PREVIOUS:path.resolve(previous),PLAYGROUND_ROLLBACK_CANDIDATE:directory,PLAYGROUND_ROLLBACK_REPORT:output},path.join(out,'rollback.browser.log'));const bytes=await fs.readFile(output),result=JSON.parse(bytes);assert.equal(result.status,'passed');assert.equal(result.candidate.candidateId,identity.candidateId);report.checks.push({name:'rollback',status:'passed',report:output,sha256:createHash('sha256').update(bytes).digest('hex'),candidateId:identity.candidateId});}
  report.status='passed';
 }
}catch(error){report.status='failed';report.error=String(error);report.stack=error.stack;process.exitCode=1;}
finally{await fs.writeFile(path.join(out,'product-suite.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}

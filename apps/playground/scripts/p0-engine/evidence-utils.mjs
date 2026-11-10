import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const EVIDENCE_SCHEMA_VERSION=2;
const base='apps/playground/scripts/p0-engine/';
const validation=[base+'evidence-utils.mjs',base+'assess.mjs'];
const common=[...validation,base+'run-probes.mjs','scripts/jsb.react-browser/dist/pck.js'];
export const REQUIRED_SOURCE_PATHS=Object.freeze({
 api:Object.freeze([...common,base+'api-fixture.mjs',base+'api-probe.cjs']),
 boot:Object.freeze([...common,base+'boot-fixture.mjs']),
 bootFault:Object.freeze([...common,base+'boot-fixture.mjs']),
 react:Object.freeze([...common,base+'react-fixture.mjs',base+'react-probe.ts',base+'react-direct.ts',base+'react-build.mjs']),
 aba:Object.freeze([...common,base+'react-aba-fixture.mjs',base+'react-aba-probe.ts']),
 webWeak:Object.freeze([...common,base+'web-weak-callback-fixture.mjs',base+'web-weak-callback-probe.ts']),
 types:Object.freeze([...validation,base+'api-types.mjs']),
 stability:Object.freeze([...common,base+'api-fixture.mjs',base+'api-probe.cjs']),
 lifecycle:Object.freeze([...validation,base+'lifecycle-run.mjs',base+'lifecycle-probe.cjs','scripts/jsb.react-browser/src/runner.ts','scripts/jsb.react-browser/src/protocol.ts','scripts/jsb.react-browser/src/verified-loader.ts','scripts/jsb.react-browser/src/pck.ts','apps/playground/preview.ts']),
});
export const canonicalJson=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonicalJson).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export const repositoryRoot=()=>path.resolve(process.env.P0_REPO_ROOT??fileURLToPath(new URL('../../../../',import.meta.url)));
export const evidenceRoot=()=>path.resolve(process.env.P0_EVIDENCE_ROOT??path.join(repositoryRoot(),'work/playground/p0'));

export async function collectSourceHashes(paths,{repoRoot=repositoryRoot()}={}){
 const root=path.resolve(repoRoot),hashes={};
 for(const name of [...new Set(paths)].sort()){
  const absolute=path.resolve(root,name),relative=path.relative(root,absolute).split(path.sep).join('/');
  if(relative==='..'||relative.startsWith('../')||path.isAbsolute(relative))throw Error('Evidence source escapes repository: '+name);
  hashes[relative]=sha256(await readFile(absolute));
 }
 return hashes;
}
async function engineIdentity(engineJs,engineWasm){
 if(!engineJs||!engineWasm)throw Error('Actual engineJs and engineWasm paths are required');
 const [js,wasm]=await Promise.all([readFile(engineJs),readFile(engineWasm)]);
 return {jsSha256:sha256(js),wasmSha256:sha256(wasm)};
}
export async function createCandidateReceipt({engineJs,engineWasm,sourcePaths,directory=evidenceRoot(),repoRoot=repositoryRoot(),candidateId,validationRunId=randomUUID()}={}){
 if(!Array.isArray(sourcePaths)||!sourcePaths.length)throw Error('Candidate requires a nonempty source file set');
 const engine=await engineIdentity(engineJs,engineWasm),sourceHashes=await collectSourceHashes(sourcePaths,{repoRoot});
 const receipt={schemaVersion:EVIDENCE_SCHEMA_VERSION,candidateId:candidateId??sha256(canonicalJson({engine,sourceHashes})),validationRunId,createdAt:new Date().toISOString(),engine,sourceHashes};
 await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'candidate-receipt.json'),JSON.stringify(receipt,null,2));return receipt;
}
export async function createEvidenceReceipt(sourcePaths,{engineJs=process.env.P0_ENGINE_JS,engineWasm=process.env.P0_ENGINE_WASM,directory=evidenceRoot(),repoRoot=repositoryRoot()}={}){
 const candidate=JSON.parse(await readFile(path.join(directory,'candidate-receipt.json'),'utf8'));
 if(candidate.schemaVersion!==EVIDENCE_SCHEMA_VERSION||!candidate.candidateId||!candidate.validationRunId)throw Error('A schema 2 candidate receipt is required before evidence collection');
 const engine=await engineIdentity(engineJs,engineWasm),sourceHashes=await collectSourceHashes(sourcePaths,{repoRoot});
 if(engine.jsSha256!==candidate.engine?.jsSha256||engine.wasmSha256!==candidate.engine?.wasmSha256)throw Error('Evidence engine differs from frozen candidate');
 for(const [name,hash]of Object.entries(sourceHashes))if(candidate.sourceHashes?.[name]!==hash)throw Error('Evidence source differs from frozen candidate: '+name);
 return {schemaVersion:EVIDENCE_SCHEMA_VERSION,candidateId:candidate.candidateId,validationRunId:candidate.validationRunId,createdAt:new Date().toISOString(),engine,sourceHashes};
}

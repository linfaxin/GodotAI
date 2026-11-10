// Fresh target-engine evidence only. Prior report files are never used as input.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runFixture} from './run-probes.mjs';
import {createApiFixture} from './api-fixture.mjs';
import {checkApiTypes} from './api-types.mjs';
import {canonicalJson,sha256,evidenceRoot,createEvidenceReceipt,REQUIRED_SOURCE_PATHS} from './evidence-utils.mjs';

export async function runApiSweep(){
 const output=evidenceRoot();await mkdir(output,{recursive:true});
 const engineJs=path.resolve(process.env.P0_ENGINE_JS??path.join(output,'full-engine/godot.js'));
 const engineWasm=path.resolve(process.env.P0_ENGINE_WASM??path.join(output,'full-engine/godot.wasm'));
 // The declaration consumer's receipt uses these same actual target paths.
 process.env.P0_ENGINE_JS=engineJs;process.env.P0_ENGINE_WASM=engineWasm;
 const requireEvidence=process.env.P0_REQUIRE_EVIDENCE==='1';
 const receipt=requireEvidence?await createEvidenceReceipt(REQUIRED_SOURCE_PATHS.stability,{engineJs,engineWasm,directory:output}):undefined;
 const rounds=[],freshIR=new Map();
 for(const [camel,round]of [[false,1],[false,2],[true,1]]){
  const mode=camel?'camel':'snake';
  try{
   const fixture=await createApiFixture({camel});
   const result=await runFixture(fixture,{engineJs,engineWasm});
   assert.equal(result.report?.naming,mode,'Probe reported a different naming mode');
   const attachment=result.attachments?.['api-ir.json'];
   assert.equal(attachment,`api-${mode}-api-ir.json`,'A newly collected IR attachment is required');
   const text=await readFile(path.join(output,attachment),'utf8'),ir=JSON.parse(text);
   assert.equal(ir.bindingNaming,mode,'IR naming must match its native fixture');
   if(requireEvidence){
    assert.equal(result.evidenceReceipt?.candidateId,receipt.candidateId,'Candidate changed during API collection');
    assert.equal(result.evidenceReceipt?.validationRunId,receipt.validationRunId,'Validation batch changed during API collection');
   }
   const apiHash=sha256(canonicalJson(ir));
   rounds.push({mode,round,status:result.status,apiHash,packSha256:result.packSha256,engine:result.engine,report:result.report});
   freshIR.set(mode,ir);
   if(!camel&&round===1){
    await writeFile(path.join(output,'api-snake-first-ir.json'),text);
    await writeFile(path.join(output,'api-snake-first-browser.json'),JSON.stringify(result,null,2));
   }
   console.log(JSON.stringify({mode,round,status:result.status,apiHash,classes:result.report.observations?.classCount}));
  }catch(error){
   // Missing fresh evidence is a failed round, never an excuse to reuse an old file.
   rounds.push({mode,round,status:'failed',error:String(error),stack:error?.stack});
   freshIR.delete(mode);
   console.error(JSON.stringify({mode,round,status:'failed',error:String(error)}));
  }
 }
 let finalReceipt=receipt;
 if(requireEvidence){
  finalReceipt=await createEvidenceReceipt(REQUIRED_SOURCE_PATHS.stability,{engineJs,engineWasm,directory:output});
  assert.equal(finalReceipt.candidateId,receipt.candidateId,'Candidate changed during sweep');
  assert.equal(finalReceipt.validationRunId,receipt.validationRunId,'Validation batch changed during sweep');
 }
 const snake=rounds.filter(item=>item.mode==='snake');
 const stableSnakeIR=snake.length===2&&typeof snake[0].apiHash==='string'&&snake[0].apiHash===snake[1].apiHash;
 const naming={status:stableSnakeIR&&rounds.length===3&&rounds.every(item=>item.status==='passed')?'passed':'failed',stableSnakeIR,...(finalReceipt?{evidenceReceipt:finalReceipt}:{}),rounds};
 await writeFile(path.join(output,'api-naming-stability.json'),JSON.stringify(naming,null,2));
 const types={};
 for(const mode of ['snake','camel']){
  const ir=freshIR.get(mode);
  if(!ir){types[mode]={status:'failed',error:'No successfully collected current-run IR; declaration check was not executed'};continue;}
  try{
   const checked=await checkApiTypes(ir,{outputDirectory:output});
   types[mode]={status:checked.status,checks:checked.checks,irSha256:checked.irSha256,declarationsSha256:checked.declarationsSha256,evidence:`api-types-${mode}-report.json`};
   console.log(JSON.stringify({mode,kind:'types',...types[mode]}));
  }catch(error){types[mode]={status:'failed',error:String(error),stack:error?.stack};console.error(JSON.stringify({mode,kind:'types',status:'failed',error:String(error)}));}
 }
 const summary={status:naming.status==='passed'&&Object.values(types).every(item=>item.status==='passed')?'passed':'failed',engine:{js:engineJs,wasm:engineWasm},rounds:rounds.map(({report,...item})=>item),stableSnakeIR,types,...(finalReceipt?{evidenceReceipt:finalReceipt}:{}),evidence:'api-naming-stability.json'};
 await writeFile(path.join(output,'api-sweep.json'),JSON.stringify(summary,null,2));
 return summary;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{const result=await runApiSweep();console.log(JSON.stringify(result,null,2));if(result.status!=='passed')process.exitCode=2;}
 catch(error){console.error(error);process.exitCode=1;}
}

import {createHash} from 'node:crypto';
import {canonicalIdentityJson} from './release-identities.mjs';
import {legacyExecution,validateExecutionContract} from './execution-contract.mjs';
export const executionContractHash=execution=>createHash('sha256').update(canonicalIdentityJson(execution)).digest('hex');
export function assertExecutionObservation(execution,report,scope='integration'){
  execution??=legacyExecution();validateExecutionContract(execution,{requireWorkerAssets:true});
  if(execution.executionModel==='window')return;
  const value=report.execution;
  const reject=detail=>{throw Error('E_EXECUTION_EVIDENCE: '+scope+' '+detail);};
  if(!value||value.contractHash!==executionContractHash(execution)||value.executionModel!==execution.executionModel)reject('does not bind the actual execution contract');
  if(value.engineWorkerExecution!==true)reject('does not observe execution in the engine Worker');
  if(execution.requiresCrossOriginIsolation&&value.isolatedContexts!==true)reject('does not observe isolated host/preview/worker contexts');
  if(scope==='integration'&&value.roleRouting!==true)reject('does not exercise explicit role routing');
  if(scope==='stress'&&value.poolTermination!==true)reject('does not exercise the whole session thread pool');
}
export function assertExecutionCertification(execution,evidence){
  execution??=legacyExecution();
  if(execution.executionModel==='window')return;
  assertExecutionObservation(execution,{execution:evidence.execution},'integration');
  if(evidence.execution.poolTermination!==true)throw Error('E_EXECUTION_EVIDENCE: Certification lacks whole-pool termination');
}

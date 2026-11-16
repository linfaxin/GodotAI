/** Pure wire contract: safe in compiler Workers and API-only consumers. */
export interface ExecutionWorkerAsset {path:string;sha256:string;bytes:number;role:'pthread-runtime'|'worker-bootstrap'|'host-glue'|'engine-main'}
export interface ExecutionContract {
  schemaVersion:1;
  executionModel:'window'|'proxy-pthread'|'dedicated-worker';
  wasmThreads:boolean;
  proxyToPthread:boolean;
  requiresCrossOriginIsolation:boolean;
  hostProtocolVersion:number;
  /** Supplied only by a source-bound build with the native pre-exit gate. */
  lifecycleAbi?:1;
  routerProtocolVersion?:number;
  workerBootstrap?:'embedded'|'separate';
  workerAssets?:ExecutionWorkerAsset[];
}
export function legacyExecution():ExecutionContract{return {schemaVersion:1,executionModel:'window',wasmThreads:false,proxyToPthread:false,requiresCrossOriginIsolation:false,hostProtocolVersion:1};}
export function validateExecution(value:unknown):asserts value is ExecutionContract{
  const v=value as ExecutionContract;
  const reject=(detail:string):never=>{throw Error('E_EXECUTION_CONTRACT: '+detail);};
  if(!v||v.schemaVersion!==1||!['window','proxy-pthread','dedicated-worker'].includes(v.executionModel))reject('Unsupported execution model');
  for(const key of ['wasmThreads','proxyToPthread','requiresCrossOriginIsolation'] as const)if(typeof v[key]!=='boolean')reject('Invalid '+key);
  if(!Number.isSafeInteger(v.hostProtocolVersion)||v.hostProtocolVersion<1)reject('Invalid host protocol');
  if(v.lifecycleAbi!==undefined&&v.lifecycleAbi!==1)reject('Unsupported lifecycle ABI');
  if(v.routerProtocolVersion!==undefined&&(!Number.isSafeInteger(v.routerProtocolVersion)||v.routerProtocolVersion<1))reject('Invalid router protocol');
  if(v.proxyToPthread!==(v.executionModel==='proxy-pthread')||(v.proxyToPthread&&!v.wasmThreads)||(v.wasmThreads&&!v.requiresCrossOriginIsolation))reject('Inconsistent thread model');
  if(v.workerBootstrap!==undefined&&!['embedded','separate'].includes(v.workerBootstrap))reject('Invalid worker layout');
  if(v.workerAssets!==undefined&&!Array.isArray(v.workerAssets))reject('Invalid worker assets');
  const seen=new Set<string>();
  for(const asset of v.workerAssets??[]){
    if(!asset||typeof asset.path!=='string'||asset.path.startsWith('/')||asset.path.includes('\\')||asset.path.split('/').some(part=>!part||part==='.'||part==='..')||seen.has(asset.path)||!/^[a-f0-9]{64}$/i.test(asset.sha256)||!Number.isSafeInteger(asset.bytes)||asset.bytes<=0||!['pthread-runtime','worker-bootstrap','host-glue','engine-main'].includes(asset.role))reject('Invalid worker asset closure');
    seen.add(asset.path);
  }
  if(v.executionModel!=='window'&&!v.workerAssets?.length&&v.workerBootstrap!=='embedded')reject('Missing worker asset closure');
}

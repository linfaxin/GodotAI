import type {RunIdentity} from './protocol.js';

export const WORKER_PROTOCOL = 2 as const;
export interface WorkerRunConfiguration {
 executionBackend:'worker';
 presentationBackend:'direct'|'bitmap';
 runtimeProtocolVersion:typeof WORKER_PROTOCOL;
 hostAbiVersion:number;
 audioAbiVersion:number;
 presentationAbiVersion:number;
 budgets:Readonly<Record<string,number>>;
}
export type WorkerRunConfigurationOptions=Partial<Omit<WorkerRunConfiguration,'budgets'>>&{budgets?:Readonly<Record<string,number>>};
export const DEFAULT_WORKER_RUN_CONFIGURATION:Readonly<WorkerRunConfiguration>=Object.freeze({
 executionBackend:'worker',presentationBackend:'direct',runtimeProtocolVersion:WORKER_PROTOCOL,
 hostAbiVersion:1,audioAbiVersion:1,presentationAbiVersion:1,
 budgets:Object.freeze({hostSetupTimeoutMs:15000,cleanupTimeoutMs:1000,maxCanvasPixels:16777216,maxCanvasDimension:8192,maxDpr:4,audioSampleBytes:67108864,audioPcmBytes:4194304,maxInputEvents:1024,maxHostCommands:512,maxPresentationBytes:268435456,maxProjectEvents:64,maxProjectBytes:1048576,maxLogMessages:1000,maxLogBytes:256000,bitmapCredits:1,benchmarkTimingSamples:0}),
});
export interface WorkerRunIdentity extends RunIdentity {
 documentId:string;
 workerId:string;
 runConfigurationHash:string;
}
/** Only the envelope header is shared. Each channel validates its own payload. */
export interface WorkerEnvelope extends WorkerRunIdentity {
 protocolVersion:typeof WORKER_PROTOCOL;
 type:string;
 [key:string]:unknown;
}
const hashPattern=/^[a-f0-9]{64}$/;
const text=(value:unknown,max=256):value is string=>typeof value==='string'&&value.length>0&&value.length<=max;
const integer=(value:unknown,min=0):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;
const revision=(value:unknown)=>text(value)||integer(value);
function record(value:unknown):value is Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const prototype=Object.getPrototypeOf(value);
 if(prototype!==Object.prototype&&prototype!==null)return false;
 return Reflect.ownKeys(value).every(key=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);return typeof key==='string'&&!!descriptor&&descriptor.enumerable===true&&'value' in descriptor;});
}
export function isWorkerRunIdentity(value:unknown):value is WorkerRunIdentity {
 try{if(!record(value))return false;
 return text(value.runId)&&revision(value.revision)&&text(value.buildKey)&&revision(value.generation)&&text(value.documentId)&&text(value.workerId)&&typeof value.runConfigurationHash==='string'&&hashPattern.test(value.runConfigurationHash);
 }catch{return false;}
}
export function sameWorkerRun(left:WorkerRunIdentity,right:WorkerRunIdentity):boolean {
 return ['runId','revision','buildKey','generation','documentId','workerId','runConfigurationHash'].every(key=>left[key as keyof WorkerRunIdentity]===right[key as keyof WorkerRunIdentity]);
}
export function freezeWorkerRunIdentity(value:WorkerRunIdentity):Readonly<WorkerRunIdentity>{
 if(!isWorkerRunIdentity(value))throw Error('E_WORKER_IDENTITY');
 return Object.freeze({runId:value.runId,revision:value.revision,buildKey:value.buildKey,generation:value.generation,documentId:value.documentId,workerId:value.workerId,runConfigurationHash:value.runConfigurationHash});
}
export function isWorkerEnvelope(value:unknown):value is WorkerEnvelope {
 if(!isWorkerRunIdentity(value))return false;const header=value as WorkerEnvelope;
 return header.protocolVersion===WORKER_PROTOCOL&&text(header.type,96);
}
export function assertWorkerRunConfiguration(value:unknown):asserts value is WorkerRunConfiguration {
 if(!record(value))throw Error('E_WORKER_CONFIGURATION');
 const keys=['executionBackend','presentationBackend','runtimeProtocolVersion','hostAbiVersion','audioAbiVersion','presentationAbiVersion','budgets'];
 if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw Error('E_WORKER_CONFIGURATION_FIELDS');
 if(value.executionBackend!=='worker'||!['direct','bitmap'].includes(value.presentationBackend as string)||value.runtimeProtocolVersion!==WORKER_PROTOCOL||!integer(value.hostAbiVersion,1)||!integer(value.audioAbiVersion,1)||!integer(value.presentationAbiVersion,1))throw Error('E_WORKER_CONFIGURATION_ABI');
 if(!record(value.budgets)||Object.keys(value.budgets).length>32)throw Error('E_WORKER_CONFIGURATION_BUDGETS');
 for(const [key,limit]of Object.entries(value.budgets))if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)||!integer(limit))throw Error('E_WORKER_CONFIGURATION_BUDGETS');
 for(const key of ['hostSetupTimeoutMs','cleanupTimeoutMs']){
  const limit=value.budgets[key];if(limit!==undefined&&(!integer(limit,1)||limit>2147483647))throw Error('E_WORKER_CONFIGURATION_BUDGETS');
 }
 for(const key of ['maxCanvasDimension','maxCanvasPixels','maxDpr','audioSampleBytes','audioPcmBytes','maxInputEvents','maxHostCommands','maxPresentationBytes','maxProjectEvents','maxProjectBytes']){
  const limit=value.budgets[key];if(limit!==undefined&&!integer(limit,1))throw Error('E_WORKER_CONFIGURATION_BUDGETS');
 }
 if(value.budgets.bitmapCredits!==undefined&&value.budgets.bitmapCredits!==1)throw Error('E_WORKER_CONFIGURATION_BUDGETS');
 if(value.budgets.benchmarkTimingSamples!==undefined&&(!integer(value.budgets.benchmarkTimingSamples)||value.budgets.benchmarkTimingSamples>4096))throw Error('E_WORKER_CONFIGURATION_BUDGETS');
}
/** Private immutable copy; the caller can still edit its original configuration. */
export function freezeWorkerRunConfiguration(value:WorkerRunConfiguration):Readonly<WorkerRunConfiguration> {
 assertWorkerRunConfiguration(value);
 return Object.freeze({...value,budgets:Object.freeze({...value.budgets})});
}
export function canonicalWorkerRunConfiguration(value:WorkerRunConfiguration):string {
 const config=freezeWorkerRunConfiguration(value),budgets=Object.fromEntries(Object.entries(config.budgets).sort(([a],[b])=>a<b?-1:a>b?1:0));
 return JSON.stringify({executionBackend:config.executionBackend,presentationBackend:config.presentationBackend,runtimeProtocolVersion:config.runtimeProtocolVersion,hostAbiVersion:config.hostAbiVersion,audioAbiVersion:config.audioAbiVersion,presentationAbiVersion:config.presentationAbiVersion,budgets});
}
export async function hashWorkerRunConfiguration(value:WorkerRunConfiguration):Promise<string> {
 const bytes=new TextEncoder().encode(canonicalWorkerRunConfiguration(value));
 const hash=await crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');
}
export async function prepareWorkerRunConfiguration(value:WorkerRunConfigurationOptions={}):Promise<{configuration:Readonly<WorkerRunConfiguration>;hash:string}> {
 if(!record(value)||Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_WORKER_RUN_CONFIGURATION,key))||(value.budgets!==undefined&&!record(value.budgets)))throw Error('E_WORKER_CONFIGURATION_FIELDS');
 const configuration=freezeWorkerRunConfiguration({...DEFAULT_WORKER_RUN_CONFIGURATION,...value,budgets:{...DEFAULT_WORKER_RUN_CONFIGURATION.budgets,...value.budgets}});
 return {configuration,hash:await hashWorkerRunConfiguration(configuration)};
}

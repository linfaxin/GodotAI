import {freezeWorkerRunIdentity,type WorkerRunIdentity} from './worker-protocol.js';

/** Revocation is synchronous and irreversible. Callers fence every async continuation. */
export class WorkerSessionLease {
 private revoked=false;
 private cause:unknown;
 get active():boolean{return !this.revoked;}
 get reason():unknown{return this.cause;}
 cancel(reason:unknown=new DOMException('Worker session cancelled','AbortError')):boolean {
  if(this.revoked)return false;this.revoked=true;this.cause=reason;return true;
 }
 assertActive():void {if(this.revoked)throw this.cause;}
 /** A resource which completes after cancellation must be released, not adopted. */
 async retain<T>(pending:T|PromiseLike<T>,release:(value:T)=>void|PromiseLike<void>):Promise<T>{
  const value=await pending;if(this.active)return value;
  try{await release(value);}finally{this.assertActive();}
  throw Error('E_WORKER_LEASE');
 }
 async create<T>(create:()=>T|PromiseLike<T>,release:(value:T)=>void|PromiseLike<void>):Promise<T>{
  this.assertActive();return this.retain(create(),release);
 }
}
export type WorkerEngineOutcome=
 | {kind:'native-exit';code:number}
 | {kind:'terminate-issued'}
 | {kind:'startup-failed';detail?:string}
 | {kind:'runtime-failed';detail?:string}
 | {kind:'host-lost';detail?:string};
export type WorkerHostCleanupOutcome={status:'complete'}|{status:'failed'|'timed-out';detail?:string};
function dataRecord(value:unknown):value is Record<string,unknown>{
 try{if(!value||typeof value!=='object'||Array.isArray(value))return false;const prototype=Object.getPrototypeOf(value);if(prototype!==null&&prototype!==Object.prototype)return false;
 return Reflect.ownKeys(value).every(key=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);return typeof key==='string'&&!!descriptor&&descriptor.enumerable===true&&'value' in descriptor;});}catch{return false;}
}
export function isWorkerEngineOutcome(value:unknown):value is WorkerEngineOutcome {
 if(!dataRecord(value))return false;
 if(value.kind==='native-exit')return Object.keys(value).length===2&&typeof value.code==='number'&&Number.isSafeInteger(value.code);
 if(value.kind==='terminate-issued')return Object.keys(value).length===1;
 return ['startup-failed','runtime-failed','host-lost'].includes(value.kind as string)&&Object.keys(value).every(key=>key==='kind'||key==='detail')&&(value.detail===undefined||(typeof value.detail==='string'&&value.detail.length<=4096));
}
export function isWorkerHostCleanupOutcome(value:unknown):value is WorkerHostCleanupOutcome {
 if(!dataRecord(value))return false;
 if(value.status==='complete')return Object.keys(value).length===1;
 return ['failed','timed-out'].includes(value.status as string)&&Object.keys(value).every(key=>key==='status'||key==='detail')&&(value.detail===undefined||(typeof value.detail==='string'&&value.detail.length<=4096));
}
export interface WorkerExitReport extends WorkerRunIdentity {
 reason:'clean-exit'|'forced-worker-termination'|'crashed'|'host-cleanup-failed'|'host-lost';
 code?:number;
 engineOutcome:Readonly<WorkerEngineOutcome>;
 hostCleanup:Readonly<WorkerHostCleanupOutcome>;
}
function detail(error:unknown):string {
 try{return (error instanceof Error?error.message:typeof error==='string'?error:'Host cleanup failed').slice(0,4096);}catch{return 'Host cleanup failed';}
}
/** Pure bookkeeping: outcomes are reports from the host, not native-exit attestation. */
export class WorkerExitLedger {
 private readonly identity:WorkerRunIdentity;
 private engine?:Readonly<WorkerEngineOutcome>;
 private cleanup?:Readonly<WorkerHostCleanupOutcome>;
 private settled?:Readonly<WorkerExitReport>;
 constructor(identity:WorkerRunIdentity){this.identity=freezeWorkerRunIdentity(identity);}
 get report():Readonly<WorkerExitReport>|undefined{return this.settled;}
 recordEngine(outcome:WorkerEngineOutcome):Readonly<WorkerExitReport>|undefined {
  if(this.engine)return this.settled;
  if(!isWorkerEngineOutcome(outcome))throw Error('E_WORKER_ENGINE_OUTCOME');
  this.engine=Object.freeze({...outcome});return this.finish();
 }
 recordCleanup(outcome:WorkerHostCleanupOutcome):Readonly<WorkerExitReport>|undefined {
  if(this.cleanup)return this.settled;if(!isWorkerHostCleanupOutcome(outcome))throw Error('E_WORKER_HOST_CLEANUP');this.cleanup=Object.freeze({...outcome});return this.finish();
 }
 private finish():Readonly<WorkerExitReport>|undefined {
  if(this.settled||!this.engine||!this.cleanup)return this.settled;
  const engine=this.engine,cleanup=this.cleanup;
  const reason:WorkerExitReport['reason']=engine.kind==='host-lost'?'host-lost':engine.kind==='terminate-issued'?'forced-worker-termination':engine.kind!=='native-exit'||engine.code!==0?'crashed':cleanup.status!=='complete'?'host-cleanup-failed':'clean-exit';
  return this.settled=Object.freeze({...this.identity,reason,...(engine.kind==='native-exit'?{code:engine.code}:{}),engineOutcome:engine,hostCleanup:cleanup});
 }
}
/** Bounds asynchronous cleanup; it cannot preempt a synchronously blocked JS realm. */
export function boundedWorkerCleanup(cleanup:(signal:AbortSignal)=>void|PromiseLike<void>,timeoutMs:number):Promise<WorkerHostCleanupOutcome>{
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>2147483647)throw Error('E_WORKER_CLEANUP_TIMEOUT');
 return new Promise(resolve=>{
  const aborter=new AbortController();let settled=false;
  const finish=(outcome:WorkerHostCleanupOutcome)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(Object.freeze(outcome));};
  const timer=setTimeout(()=>{finish({status:'timed-out',detail:'Host cleanup deadline exceeded'});aborter.abort(new DOMException('Host cleanup timed out','TimeoutError'));},timeoutMs);
  try{Promise.resolve(cleanup(aborter.signal)).then(()=>finish({status:'complete'}),error=>finish({status:'failed',detail:detail(error)}));}
  catch(error){finish({status:'failed',detail:detail(error)});}
 });
}
export interface WorkerHeartbeatMessage {sequence:number;resumeEpoch:number}
export function isWorkerHeartbeatMessage(value:unknown):value is WorkerHeartbeatMessage {
 return dataRecord(value)&&typeof value.sequence==='number'&&Number.isSafeInteger(value.sequence)&&value.sequence>=0&&typeof value.resumeEpoch==='number'&&Number.isSafeInteger(value.resumeEpoch)&&value.resumeEpoch>=0;
}
/** Host-local monotonic receipt time. No pixel, frame or user-code trust claim. */
export class WorkerHeartbeat {
 private mode:'active'|'suspended'|'resuming'|'closed'='active';
 private epoch=0;
 private sequence=-1;
 private lastReceipt:number;
 constructor(now:number){this.time(now);this.lastReceipt=now;}
 get state():typeof this.mode{return this.mode;}
 get resumeEpoch():number{return this.epoch;}
 private time(now:number):void{if(!Number.isFinite(now)||now<0)throw Error('E_WORKER_HEARTBEAT_TIME');}
 suspend():void{if(this.mode!=='closed')this.mode='suspended';}
 beginResume(now:number):number{
  this.time(now);if(this.mode==='closed')throw Error('E_WORKER_HEARTBEAT_CLOSED');
  if(this.mode!=='resuming'){this.epoch++;this.sequence=-1;this.lastReceipt=now;this.mode='resuming';}
  return this.epoch;
 }
 accept(message:WorkerHeartbeatMessage,now:number):boolean {
  this.time(now);if(this.mode!=='active')return false;return this.receive(message,now);
 }
 acknowledgeResume(message:WorkerHeartbeatMessage,now:number):boolean {
  this.time(now);if(this.mode!=='resuming'||!this.receive(message,now))return false;this.mode='active';return true;
 }
 private receive(message:WorkerHeartbeatMessage,now:number):boolean {
  if(!isWorkerHeartbeatMessage(message)||message.sequence<=this.sequence||message.resumeEpoch!==this.epoch||now<this.lastReceipt)return false;
  this.sequence=message.sequence;this.lastReceipt=now;return true;
 }
 timedOut(now:number,timeoutMs:number):boolean {
  this.time(now);if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('E_WORKER_HEARTBEAT_TIMEOUT');
  return(this.mode==='active'||this.mode==='resuming')&&now-this.lastReceipt>timeoutMs;
 }
 close():void{this.mode='closed';}
}

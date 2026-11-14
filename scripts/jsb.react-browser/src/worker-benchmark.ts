/** Opt-in benchmark observations. No capability/pixel probes and no physical
 * display or hardware-input claim. Cross-realm timestamps use each realm's
 * performance.timeOrigin + performance.now(); cross-realm precision can reverse
 * adjacent readings. Preserve those raw readings; their intervals are unavailable,
 * never clamped. Capture and ACK RTT use one Worker clock. */
export const BENCHMARK_SAMPLE_LIMIT = 4096;
export const benchmarkNow = () => performance.timeOrigin + performance.now();
export interface BenchmarkInputTiming { capturedAtMs:number; forwardedAtMs:number; trusted:boolean }
export interface BenchmarkHostFrameTiming { receivedAtMs:number; consumedAtMs:number;disposition:'consumed'|'released' }
export interface BenchmarkInputSample {
 sequence:number;event:string;code:string;trusted:boolean;
 capturedAtMs:number;forwardedAtMs:number;workerReceivedAtMs:number;
 workerDispatchedAtMs:number|null;nativeConsumedAtMs:number|null;
}
export interface BenchmarkFrameSample {
 frameId:number;resizeEpoch:number;captureStartedAtMs:number;captureEndedAtMs:number;
 hostReceivedAtMs:number|null;hostConsumedAtMs:number|null;ackReceivedAtMs:number|null;
 hostDisposition:'consumed'|'released'|null;
}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export class WorkerBenchmark {
 private inputs=new Map<number,BenchmarkInputSample>();
 private frames=new Map<number,BenchmarkFrameSample>();
 private rejected=0;
 private evictedInputs=0;
 private evictedFrames=0;
 constructor(private readonly limit:number,private readonly now:()=>number=benchmarkNow){
  if(!Number.isSafeInteger(limit)||limit<1||limit>BENCHMARK_SAMPLE_LIMIT)throw Error('E_WORKER_BENCHMARK_BUDGET');
 }
 inputReceived(packet:{sequence:number;event:string;fields:Record<string,unknown>;timing?:BenchmarkInputTiming}):void {
  const t=packet.timing,at=this.now();
  if(!t||!Number.isSafeInteger(packet.sequence)||this.inputs.has(packet.sequence)||!finite(t.capturedAtMs)||!finite(t.forwardedAtMs)||!finite(at)||t.forwardedAtMs<t.capturedAtMs){this.rejected++;return;}
  if(this.inputs.size>=this.limit){this.inputs.delete(this.inputs.keys().next().value!);this.evictedInputs++;}
  this.inputs.set(packet.sequence,{sequence:packet.sequence,event:packet.event.slice(0,64),code:typeof packet.fields.code==='string'?packet.fields.code.slice(0,64):'',trusted:t.trusted===true,
   capturedAtMs:t.capturedAtMs,forwardedAtMs:t.forwardedAtMs,workerReceivedAtMs:at,workerDispatchedAtMs:null,nativeConsumedAtMs:null});
 }
 inputDispatched(sequence:number,accepted:boolean):void {
  const row=this.inputs.get(sequence),at=this.now();if(!row)return;
  if(!accepted||!finite(at)||at<row.workerReceivedAtMs){this.inputs.delete(sequence);this.rejected++;return;}
  row.workerDispatchedAtMs=at;
 }
 /** Invoked by an actual native _input callback in the benchmark fixture,
  * not by receiving/dispatching a DOM packet or by an editor-side ACK. */
 nativeInputConsumed(event:string,code:string):boolean {
  const row=[...this.inputs.values()].find(value=>value.event===event&&value.code===code&&value.nativeConsumedAtMs===null);
  if(!row)return false;const at=this.now();if(!finite(at)||at<row.workerReceivedAtMs){this.rejected++;return false;}
  row.nativeConsumedAtMs=at;return true;
 }
 frameCaptured(frame:{frameId:number;resizeEpoch:number},started:number,ended:number):void {
  if(!Number.isSafeInteger(frame.frameId)||frame.frameId<1||!Number.isSafeInteger(frame.resizeEpoch)||frame.resizeEpoch<0||!finite(started)||!finite(ended)||ended<started||this.frames.has(frame.frameId)){this.rejected++;return;}
  if(this.frames.size>=this.limit){this.frames.delete(this.frames.keys().next().value!);this.evictedFrames++;}
  this.frames.set(frame.frameId,{frameId:frame.frameId,resizeEpoch:frame.resizeEpoch,captureStartedAtMs:started,captureEndedAtMs:ended,hostReceivedAtMs:null,hostConsumedAtMs:null,ackReceivedAtMs:null,hostDisposition:null});
 }
 frameAcknowledged(frame:{frameId:number;resizeEpoch:number;timing?:BenchmarkHostFrameTiming}):void {
  const row=this.frames.get(frame.frameId),at=this.now();if(!row||row.resizeEpoch!==frame.resizeEpoch||row.ackReceivedAtMs!==null)return;
  if(!finite(at)||at<row.captureEndedAtMs){this.rejected++;return;}
  row.ackReceivedAtMs=at;const t=frame.timing;
  if(t&&['consumed','released'].includes(t.disposition)&&finite(t.receivedAtMs)&&finite(t.consumedAtMs)&&t.consumedAtMs>=t.receivedAtMs){row.hostReceivedAtMs=t.receivedAtMs;row.hostConsumedAtMs=t.consumedAtMs;row.hostDisposition=t.disposition;}
  else if(t)this.rejected++;
 }
 snapshot(){return {schemaVersion:1,mode:'benchmark' as const,sampleLimitPerKind:this.limit,clock:'performance.timeOrigin + performance.now in each actual realm; browser precision applies',nativeInputScope:'Explicit real Native _input callback in the benchmark fixture',frameScope:'ImageBitmap capture, Host consumption/release and Worker ACK receipt; not physical display',rejectedSamples:this.rejected,evictedInputs:this.evictedInputs,evictedFrames:this.evictedFrames,inputs:[...this.inputs.values()].map(value=>({...value})),frames:[...this.frames.values()].map(value=>({...value}))};}
}

/** One direction of one immutable run. Credits cover queued JSON payload
 * bytes, not GC/RSS. Only its exact consumption receipt retires a ticket. */
export class WorkerProjectCommandCredits {
 private readonly pending=new Map<number,number>();
 private bytes=0;
 private lastSequence=0;
 constructor(private readonly maxEvents:number,private readonly maxBytes:number){
  if(!Number.isSafeInteger(maxEvents)||maxEvents<1||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('E_WORKER_PROJECT_COMMAND_BUDGET');
 }
 reserve(sequence:number,bytes:number):boolean {
  if(!Number.isSafeInteger(sequence)||sequence<=this.lastSequence||!Number.isSafeInteger(bytes)||bytes<1||this.pending.size>=this.maxEvents||this.bytes+bytes>this.maxBytes)return false;
  this.lastSequence=sequence;this.pending.set(sequence,bytes);this.bytes+=bytes;return true;
 }
 release(sequence:number):boolean {
  const bytes=this.pending.get(sequence);if(bytes===undefined)return false;
  this.pending.delete(sequence);this.bytes-=bytes;return true;
 }
 clear():void {this.pending.clear();this.bytes=0;}
 snapshot(){return {pending:this.pending.size,bytes:this.bytes};}
}
export const workerProjectCommandBytes=(data:Record<string,unknown>)=>new TextEncoder().encode(JSON.stringify(data)).byteLength;

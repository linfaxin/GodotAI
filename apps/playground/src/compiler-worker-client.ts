interface CompilePin {release():Promise<void>}
type Pending={resolve:(value:any)=>void;reject:(error:Error)=>void;pin?:CompilePin};
/** Owns one compiler generation, including requests waiting on snapshot pins. */
export class CompilerWorkerClient {
 private worker:Worker|undefined;
 private readonly pending=new Map<number,Pending>();
 private postQueue:Promise<void>=Promise.resolve();
 private readonly createWorker:()=>Worker;
 private readonly onFailure:(error:Error)=>void;
 private readonly onSourceReset:()=>void;
 constructor(createWorker:()=>Worker,onFailure:(error:Error)=>void,onSourceReset:()=>void){this.createWorker=createWorker;this.onFailure=onFailure;this.onSourceReset=onSourceReset;}
 private fail(worker:Worker,error:unknown):void {
  if(this.worker!==worker)return;
  this.worker=undefined;this.postQueue=Promise.resolve();worker.terminate();this.onSourceReset();
  const message=error instanceof Error?error.message:typeof (error as any)?.message==='string'?(error as any).message:'编译器 Worker 加载或通信失败，请重试';
  const diagnostic=new Error(message);
  for(const request of this.pending.values())request.reject(diagnostic);
  this.pending.clear();this.onFailure(diagnostic);
 }
 private acquire():Worker {
  if(this.worker)return this.worker;
  const worker=this.createWorker();this.worker=worker;
  worker.onmessage=({data})=>{
   if(this.worker!==worker)return;
   if(data.sourceSyncReset)this.onSourceReset();
   const request=this.pending.get(data.id);if(request){this.pending.delete(data.id);request.resolve(data);}
  };
  worker.onerror=event=>{event.preventDefault?.();this.fail(worker,event);};
  worker.onmessageerror=event=>{event.preventDefault?.();this.fail(worker,new Error('编译器 Worker 返回了无法读取的数据，请重试'));};
  return worker;
 }
 request(payload:Record<string,unknown>&{id:number},pin?:()=>Promise<CompilePin>):Promise<any> {
  let worker:Worker;
  try{worker=this.acquire();}catch(error){this.onSourceReset();return Promise.reject(error);}
  let request:Pending;
  const response=new Promise((resolve,reject)=>{request={resolve,reject};this.pending.set(payload.id,request);});
  const release=async()=>{const owned=request.pin;request.pin=undefined;await owned?.release();};
  this.postQueue=this.postQueue.then(async()=>{
   if(this.pending.get(payload.id)!==request)return;
   try{
    request.pin=await pin?.();
    // A Worker may fail while IDB is still creating this pin. The failed RPC
    // has already settled; this continuation still owns its eventual cleanup.
    if(this.worker!==worker||this.pending.get(payload.id)!==request){await release();return;}
    worker.postMessage(payload);
   }catch(error){this.fail(worker,error);await release();}
  }).catch(error=>{console.error('Compiler request cleanup failed',error);});
  return response.finally(release);
 }
}

/** Fixed, bounded WebAssembly compatibility probe; no engine or DOM imports. */
export const SHARED_MEMORY_GROWTH_PROBE_SHA256='cc91b7565027d1c6cad57a01953078532d746bebaab6db150c250bcf0e9aac73';
export const SHARED_MEMORY_GROWTH_PROBE_BYTES=new Uint8Array([0,97,115,109,1,0,0,0,1,16,3,96,3,127,127,127,0,96,1,127,1,127,96,0,1,127,2,16,1,3,101,110,118,6,109,101,109,111,114,121,2,3,1,4,3,5,4,1,0,0,2,7,32,4,6,114,101,97,100,51,50,0,0,4,99,111,112,121,0,1,4,102,105,108,108,0,2,5,112,97,103,101,115,0,3,10,39,4,7,0,32,0,40,2,0,11,12,0,32,0,32,1,32,2,252,10,0,0,11,11,0,32,0,32,1,32,2,252,11,0,11,4,0,63,0,11]);
interface ProbeExports {pages():number;read32(offset:number):number;copy(destination:number,source:number,length:number):void;fill(destination:number,value:number,length:number):void}
interface ProbeReply {__godotjsSharedMemoryProbe:1;type:'ready'|'complete'|'failed';detail?:string}

/** Serialized into a dedicated auxiliary host Worker. Keep closure-free. */
export function sharedMemoryGrowthWorker():void {
 const realm=globalThis as unknown as {onmessage:((event:MessageEvent)=>void)|null;postMessage(value:unknown):void;__godotjsRuntimeHost?:{assignRole(role:'host'):void}};
 realm.__godotjsRuntimeHost?.assignRole('host');
 let memory:WebAssembly.Memory,retained:ProbeExports;
 const reply=(type:ProbeReply['type'],detail?:string)=>realm.postMessage({__godotjsSharedMemoryProbe:1,type,detail});
 realm.onmessage=event=>{
  try{
   if(event.data.type==='init'){
    memory=event.data.memory;retained=new WebAssembly.Instance(event.data.module,{env:{memory}}).exports as unknown as ProbeExports;
    if(memory.buffer.byteLength!==65536||retained.pages()!==1)throw Error('initial-size');
    reply('ready');return;
   }
   if(event.data.type!=='grown'||!retained)throw Error('probe-protocol');
   // Verify both views before touching the grown region. A stale instance is
   // rejected here, without deliberately executing any out-of-range operation.
   if(memory.buffer.byteLength!==131072||retained.pages()!==2)throw Error('retained-worker-page-count');
   const data=new Uint8Array(memory.buffer),source=69632;
   if(data[source]!==0x78||data[source+3]!==0x12||retained.read32(source)!==0x12345678)throw Error('grown-read');
   retained.copy(69696,source,4);retained.copy(8192,source,4);retained.copy(69760,8192,4);retained.fill(69888,0x5a,4);
   for(const offset of [69696,8192,69760])if(retained.read32(offset)!==0x12345678)throw Error('grown-copy');
   if(retained.read32(69888)!==0x5a5a5a5a)throw Error('grown-fill');
   reply('complete');
  }catch(error){reply('failed',error instanceof Error?error.message:'worker-probe');}
 };
}

function unsupported(detail:unknown):Error {
 return new Error('E_BROWSER_SHARED_MEMORY_GROWTH: 当前浏览器不支持此 Worker 引擎模式，请升级浏览器或使用支持共享内存增长的浏览器。',{cause:detail});
}

/** Validate shared memory growth across existing Window/Worker instances.
 * The 128 KiB probe is terminated and its Blob revoked on every outcome. */
export async function assertBrowserSharedMemoryGrowth({signal,timeoutMs=5000}:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<void>{
 if(signal?.aborted)throw signal.reason??new DOMException('Cancelled','AbortError');
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('E_BROWSER_PROBE_TIMEOUT');
 let module:WebAssembly.Module,memory:WebAssembly.Memory,retained:ProbeExports;
 try{
  if(globalThis.crossOriginIsolated!==true||typeof Worker!=='function'||typeof SharedArrayBuffer!=='function')throw Error('isolated-shared-worker-unavailable');
  module=await WebAssembly.compile(SHARED_MEMORY_GROWTH_PROBE_BYTES.slice().buffer);
  memory=new WebAssembly.Memory({initial:1,maximum:4,shared:true});
  retained=new WebAssembly.Instance(module,{env:{memory}}).exports as unknown as ProbeExports;
  if(memory.buffer.byteLength!==65536||retained.pages()!==1)throw Error('initial-main-size');
 }catch(error){throw unsupported(error);}
 if(signal?.aborted)throw signal.reason??new DOMException('Cancelled','AbortError');
 await new Promise<void>((resolve,reject)=>{
  let worker:Worker|undefined,url:string|undefined,timer:ReturnType<typeof setTimeout>|undefined,settled=false,phase:'initial'|'grown'='initial';
  const finish=(error?:unknown)=>{
   if(settled)return;settled=true;
   signal?.removeEventListener('abort',cancelled);if(timer!==undefined)clearTimeout(timer);
   if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}
   if(url)URL.revokeObjectURL(url);
   if(error===undefined)resolve();else reject(error);
  };
  const cancelled=()=>finish(signal?.reason??new DOMException('Cancelled','AbortError'));
  signal?.addEventListener('abort',cancelled,{once:true});
  try{
   url=URL.createObjectURL(new Blob([`(${sharedMemoryGrowthWorker.toString()})()`],{type:'text/javascript'}));
   worker=new Worker(url,{name:'godotjs-shared-memory-preflight'});
   worker.onmessage=event=>{
    const message=event.data as ProbeReply;if(message?.__godotjsSharedMemoryProbe!==1)return;
    try{
     if(message.type==='failed')throw Error(message.detail??'worker-probe');
     if(phase==='initial'&&message.type==='ready'){
      if(memory.grow(1)!==1||memory.buffer.byteLength!==131072||retained.pages()!==2)throw Error('retained-main-page-count');
      const data=new Uint8Array(memory.buffer);data.set([0x78,0x56,0x34,0x12],69632);
      if(retained.read32(69632)!==0x12345678)throw Error('retained-main-read');
      phase='grown';worker!.postMessage({type:'grown'});return;
     }
     if(phase!=='grown'||message.type!=='complete')throw Error('probe-protocol');
     if(memory.buffer.byteLength!==131072||retained.pages()!==2)throw Error('final-shared-size');
     const data=new Uint8Array(memory.buffer);
     for(const offset of [69696,8192,69760])if(data[offset]!==0x78||data[offset+1]!==0x56||data[offset+2]!==0x34||data[offset+3]!==0x12||retained.read32(offset)!==0x12345678)throw Error('main-copy-readback');
     if(retained.read32(69888)!==0x5a5a5a5a)throw Error('main-fill-readback');
     // Also exercise the original main instance on addresses within two pages.
     retained.copy(70016,69632,4);retained.fill(70080,0x6b,4);
     if(retained.read32(70016)!==0x12345678||retained.read32(70080)!==0x6b6b6b6b)throw Error('retained-main-copy-fill');
     finish();
    }catch(error){finish(unsupported(error));}
   };
   worker.onerror=event=>{event.preventDefault();finish(unsupported(event.message));};
   worker.onmessageerror=()=>finish(unsupported('worker-message-clone'));
   timer=setTimeout(()=>finish(unsupported('worker-probe-timeout')),timeoutMs);
   worker.postMessage({type:'init',module,memory});
   if(signal?.aborted)cancelled();
  }catch(error){finish(unsupported(error));}
 });
}

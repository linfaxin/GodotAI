// Experimental adapter: real Godot/WASM rendering; DOM-facing surfaces are
// represented locally and input is forwarded from actual page events.
const emit=data=>postMessage(data);
const realm={isWorker:typeof WorkerGlobalScope!=='undefined'&&self instanceof WorkerGlobalScope,document:typeof document,shared:typeof SharedArrayBuffer};
let engine,canvas,windowTarget,documentTarget,metadata,projectCommand;
const nativeAdd=addEventListener.bind(self);
nativeAdd('error',event=>emit({type:'fatal',message:event.message,stack:event.error?.stack}));
nativeAdd('unhandledrejection',event=>emit({type:'fatal',message:String(event.reason),stack:event.reason?.stack}));
function surface(){const target=new EventTarget();return Object.assign(target,{style:{},children:[],appendChild(child){this.children.push(child);child.parentElement=this;},removeChild(child){this.children=this.children.filter(x=>x!==child);},remove(){this.parentElement?.removeChild(this);},focus(){documentTarget.activeElement=this;},blur(){documentTarget.activeElement=null;},getBoundingClientRect(){return {x:0,y:0,left:0,top:0,width:metadata.width,height:metadata.height};}});}
function dispatch(target,data){const event=new Event(data.type,{cancelable:true});for(const [key,value]of Object.entries(data))if(key!=='type')Object.defineProperty(event,key,{value});target.dispatchEvent(event);}
function adapt(offscreen,meta){
 metadata=meta;canvas=offscreen;
 windowTarget=surface();documentTarget=surface();
 const parent=surface();
 Object.assign(canvas,{id:'canvas',style:{},tabIndex:0,parentElement:parent,addEventListener:windowTarget.addEventListener.bind(windowTarget),removeEventListener:windowTarget.removeEventListener.bind(windowTarget),focus(){documentTarget.activeElement=canvas;},getBoundingClientRect:()=>({x:0,y:0,left:0,top:0,width:metadata.width,height:metadata.height})});
 Object.assign(windowTarget,{innerWidth:meta.width,innerHeight:meta.height,devicePixelRatio:meta.dpr,screen:{width:meta.width,height:meta.height},URL,location,requestAnimationFrame:self.requestAnimationFrame?.bind(self),cancelAnimationFrame:self.cancelAnimationFrame?.bind(self)});
 Object.assign(documentTarget,{activeElement:canvas,hidden:false,visibilityState:'visible',body:parent,head:surface(),documentElement:parent,currentScript:null,fullscreenElement:null,fullscreenEnabled:false,exitPointerLock(){},getElementById:id=>id==='canvas'?canvas:null,querySelector:selector=>selector==='#canvas'?canvas:null,getElementsByTagName:tag=>tag==='canvas'?[canvas]:[],createElement(tag){if(tag==='canvas')return new OffscreenCanvas(1,1);if(['div','input','textarea','link'].includes(tag)){emit({type:'adapter-surface',tag});return surface();}throw Error('Unsupported worker DOM surface: '+tag);}});
 self.window=windowTarget;self.document=documentTarget;self.HTMLCanvasElement=OffscreenCanvas;
 windowTarget.window=windowTarget;windowTarget.document=documentTarget;windowTarget.navigator=navigator;
 windowTarget.alert=text=>emit({type:'browser-alert',text});
 Object.defineProperty(navigator,'getGamepads',{value:()=>[]});
 self.__probeSend=data=>emit({...data,realm});
 windowTarget.__godotjsReportReactError=raw=>{emit({type:'react-error',data:JSON.parse(raw)});return true;};
 windowTarget.__godotjsProjectEvent=raw=>emit({type:'project-event',data:JSON.parse(raw)});
 windowTarget.__godotjsSetProjectCommand=callback=>{projectCommand=callback;};
}
nativeAdd('message',async({data})=>{
 try{
  if(data.type==='input'){dispatch(windowTarget,data.event);return;}
  if(data.type==='resize'){metadata=data.meta;windowTarget.innerWidth=metadata.width;windowTarget.innerHeight=metadata.height;canvas.width=metadata.width;canvas.height=metadata.height;emit({type:'resized',width:canvas.width,height:canvas.height});return;}
  if(data.type==='command'){self.__probeCommand?.(data.command);return;}
  if(data.type==='project-command'){projectCommand?.(JSON.stringify(data.data));return;}
  if(data.type==='stop'){engine?.requestQuit();return;}
  if(data.type!=='boot')return;
  if(!data.raw)adapt(data.canvas,data.meta);else canvas=data.canvas;
  const {fetchVerifiedAsset}=await import('/verified-loader.js');
  emit({type:'downloading'});
  const [javascript,wasm]=await Promise.all([fetchVerifiedAsset(data.release.engineJs),fetchVerifiedAsset(data.release.engineWasm)]);
  const scriptUrl=URL.createObjectURL(new Blob([javascript],{type:'text/javascript'}));
  try{importScripts(scriptUrl);}finally{URL.revokeObjectURL(scriptUrl);}
  const originalFetch=self.fetch;
  let wasmRequests=0;
  self.fetch=(input,options)=>{if(String(input)==='/engine/godot.wasm'){wasmRequests++;return Promise.resolve(new Response(wasm.slice().buffer,{headers:{'content-type':'application/wasm'}}));}throw Error('Unexpected engine load fetch: '+input);};
  try{await Engine.load('/engine/godot');}finally{self.fetch=originalFetch;}
  if(wasmRequests!==1)throw Error('Expected exactly one verified WASM request');
  engine=new Engine({canvas,executable:'/engine/godot',persistentPaths:[],persistentDrops:false,focusCanvas:false,canvasResizePolicy:0,onPrint:(...args)=>emit({type:'log',level:'log',text:args.join(' ')}),onPrintError:(...args)=>emit({type:'log',level:'error',text:args.join(' ')}),onExit:code=>emit({type:'exited',code})});
  await engine.preloadFile(data.pack,'/application.pck');
  await engine.init('/engine/godot');
  emit({type:'initialized',realm,packArrayBuffer:data.pack.buffer instanceof ArrayBuffer});
  await engine.start({args:['--main-pack','/application.pck','--rendering-method','gl_compatibility','--audio-driver',data.audio?'AudioWorklet':'Dummy']});
  emit({type:'started',realm,memoryArrayBuffer:self._jsbb_?.u8?.buffer instanceof ArrayBuffer,memoryTag:Object.prototype.toString.call(self._jsbb_?.u8?.buffer),wasmRequests,audioContext:typeof window.AudioContext});
 }catch(error){emit({type:'fatal',message:String(error),stack:error.stack});}
});

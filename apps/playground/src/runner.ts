import {suppressBrowserSave} from './browser-shortcuts';
suppressBrowserSave(window);
declare const Engine:any;
const token=location.hash.slice(1),canvas=document.querySelector("canvas")!;
const globals=globalThis as any;
// This opaque-origin preview has no persistent PWA scope. Godot otherwise
// probes navigator.serviceWorker and invokes a getter blocked by the sandbox.
const navigatorPrototype=Object.getPrototypeOf(navigator);
if(Object.getOwnPropertyDescriptor(navigatorPrototype,"serviceWorker")?.configurable)delete navigatorPrototype.serviceWorker;
const send=(event:Record<string,unknown>)=>parent.postMessage({...event,token},"*");
globals.__playgroundNotify=(event:Record<string,unknown>)=>send(event);
let ready=false;
addEventListener("message",event=>{
  if(event.source!==parent||event.data?.token!==token)return;
  const {type,code,controls,action,data,mode}=event.data;
  try{
    const api=globals.__godotPlayground;
    if(type==="run"&&ready){api.run(code,controls,mode);canvas.focus();}
    if(type==="stop"&&ready)api.stop();
    if(type==="controls"&&ready)api.controls(controls);
    if(type==="action"&&ready&&typeof action==="string")api.action(action);
    if(type==="import-data"&&ready)api.importData(data);
  }catch(error){send({type:"runtime-error",message:String(error)});}
});
addEventListener("blur",()=>globals.__godotPlayground?.clearInput());
window.addEventListener('keydown',event=>{if(event.key==='Escape')send({type:'preview-escape'});});
async function start(){
  const response=await fetch("engine.json");if(!response.ok)throw Error("Missing engine manifest");
  const config=await response.json();
  const engine=new Engine({...config,canvas,canvasResizePolicy:2,focusCanvas:false,experimentalVK:false});
  await engine.startGame({onProgress:(current:number,total:number)=>send({type:"loading",current,total}),onPrintError:(message:string)=>send({type:"engine-log",message})});
  ready=true;send({type:"ready"});
}
start().catch(error=>send({type:"runtime-error",message:`引擎启动失败：${String(error)}`}));

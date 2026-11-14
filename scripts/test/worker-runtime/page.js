window.observations=[];window.ticks=0;setInterval(()=>window.ticks++,20);
let worker,canvas;
window.start=async(mode='production',audio=false,raw=false,corrupt)=>{
 window.observations=[];
 worker?.terminate();canvas?.remove();canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;canvas.style.width='320px';canvas.style.height='240px';canvas.tabIndex=0;document.body.append(canvas);
 const offscreen=canvas.transferControlToOffscreen(),pack=new Uint8Array(await(await fetch('/'+mode+'.pck')).arrayBuffer());
 worker=new Worker('/worker.js');window.worker=worker;
 worker.onmessage=({data})=>{window.observations.push(data);console.log('OBS',JSON.stringify(data));};
 worker.onerror=event=>window.observations.push({type:'worker-error',message:event.message});
 const release=await(await fetch('/release.json')).json();
 if(corrupt==='js')release.engineJs.sha256='0'.repeat(64);
 if(corrupt==='wasm')release.engineWasm.sha256='0'.repeat(64);
 const meta={width:320,height:240,dpr:devicePixelRatio};worker.postMessage({type:'boot',canvas:offscreen,pack,meta,audio,raw,release},[offscreen,pack.buffer]);
 return {detached:pack.byteLength===0,shared:typeof SharedArrayBuffer,crossOriginIsolated};
};
window.command=command=>worker.postMessage({type:'command',command});
window.stop=()=>worker.postMessage({type:'stop'});
window.kill=()=>worker?.terminate();
window.resize=(width,height)=>{canvas.style.width=width+'px';canvas.style.height=height+'px';worker.postMessage({type:'resize',meta:{width,height,dpr:devicePixelRatio}});};
for(const type of ['keydown','keyup','pointermove','mousedown','mouseup','wheel'])addEventListener(type,event=>{
 if(!worker)return;const rect=canvas.getBoundingClientRect(),data={type,key:event.key,code:event.code,repeat:event.repeat,button:event.button,buttons:event.buttons,clientX:event.clientX-rect.x,clientY:event.clientY-rect.y,movementX:event.movementX,movementY:event.movementY,pressure:event.pressure,deltaX:event.deltaX,deltaY:event.deltaY,deltaMode:event.deltaMode,shiftKey:event.shiftKey,ctrlKey:event.ctrlKey,altKey:event.altKey,metaKey:event.metaKey};worker.postMessage({type:'input',event:data});
});
window.startMain=async()=>{
 const element=document.createElement('script');element.src='/engine/godot.js';await new Promise((done,reject)=>{element.onload=done;element.onerror=reject;document.head.append(element);});
 canvas=document.createElement('canvas');canvas.id='canvas';canvas.width=320;canvas.height=240;document.body.append(canvas);
 window.__probeSend=data=>window.observations.push(data);
 window.__godotjsSetProjectCommand=callback=>{};window.__godotjsProjectEvent=raw=>window.observations.push({type:'project-event',data:JSON.parse(raw)});window.__godotjsReportReactError=raw=>{window.observations.push({type:'react-error',data:JSON.parse(raw)});return true;};
 const engine=new Engine({canvas,executable:'/engine/godot',persistentPaths:[],persistentDrops:false,focusCanvas:false,canvasResizePolicy:0,onPrint:(...a)=>console.log(...a),onPrintError:(...a)=>console.error(...a),onExit:code=>window.observations.push({type:'exited',code})});
 await engine.preloadFile(new Uint8Array(await(await fetch('/production.pck')).arrayBuffer()),'/application.pck');await engine.init('/engine/godot');await engine.start({args:['--main-pack','/application.pck','--rendering-method','gl_compatibility','--audio-driver','Dummy']});
};
window.prepareAudio=()=>{
 const button=document.createElement('button');button.id='audio-start';button.textContent='Audio';document.body.append(button);
 button.onclick=async()=>{try{
  const context=new AudioContext();window.observations.push({type:'audio-created',state:context.state,gesture:navigator.userActivation?.isActive});await context.resume();await context.audioWorklet.addModule('/audio-worklet.js');
  const node=new AudioWorkletNode(context,'buffer-audio-probe'),channel=new MessageChannel(),producer=new Worker('/audio-worker.js');
  node.port.onmessage=({data})=>window.observations.push(data);producer.onmessage=({data})=>window.observations.push(data);
  node.port.postMessage({port:channel.port2},[channel.port2]);node.connect(context.destination);producer.postMessage({port:channel.port1,sampleRate:context.sampleRate},[channel.port1]);
  window.closeAudio=async()=>{producer.terminate();node.disconnect();await context.close();window.observations.push({type:'audio-closed',state:context.state});};
  window.observations.push({type:'audio-started',state:context.state,gesture:navigator.userActivation.isActive});
 }catch(error){window.observations.push({type:'audio-failed',message:String(error)});}};
};

declare const require:(id:string)=>any;
const G=require("godot");
const vendor=require("res://generated/vendor.js");
const {React,sdk,godot,api,projectResources}=vendor;
const manifest=require("res://generated/assets.js");
interface BridgeGlobal { __godotPlayground?:any; __playgroundNotify?:(event:any)=>void }
const world=globalThis as BridgeGlobal;
const invoke=(o:any,n:string,...a:any[])=>{const f=o[n]??o[n.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase())];return f.apply(o,a);};

export default class PlaygroundHost extends G.Node {
  private root:any;
  private projectAssets:any;
  private input:import("./api").InputState={keys:new Set(),pressed:new Set(),actions:new Set(),requests:new Set(),pointer:{x:480,y:320},down:false,clicks:[],releases:[],wheel:0};
  private services:any;
  private stats:Record<string,unknown>={};
  private sounds:string[]=[];
  private elapsed=0;
  private generation=0;
  private frames=0;
  private verify=false;
  private verifyDemo="shader";
  private failure:unknown;
  private event:(value:any)=>void=(value)=>{try{world.__playgroundNotify?.(value);}catch(error){console.error(error);}};
  _ready(){
    world.__godotPlayground={run:(code:string,controls:Record<string,number>,mode?:string,resources?:any)=>this.run(code,controls,mode,resources),stop:()=>this.stop(),controls:(controls:Record<string,number>)=>this.controls(controls),inspect:()=>this.inspect(),clearInput:()=>this.clearInput(),action:(key:string)=>this.input.requests.add(key),importData:(data:unknown)=>{this.input.imported=data;}};
    this.event({type:"engine-ready",profile:"showcase-v1"});
    const args=invoke(G.OS,"get_cmdline_user_args");
    for(let i=0;i<invoke(args,"size");i++){const a=String(invoke(args,"get_indexed",i));if(a.startsWith("--verify-demo=")){this.verify=true;this.verifyDemo=a.split("=")[1];}}
    if(this.verify){const defaults=require("res://generated/defaults.js");const demo=defaults[this.verifyDemo];this.run(demo.code,demo.controls);}
  }
  private run(code:string,controls:Record<string,number>,mode="production",resources?:any){
    this.stop();this.failure=undefined;this.clearInput();this.input.requests.clear();delete this.input.imported;this.sounds.length=0;this.stats={};this.frames=0;
    let native:any;
    try{
      if(resources)this.projectAssets=projectResources.installProjectResources(G,resources,Object.keys(manifest.assets));
      const module={exports:{} as any};
      const allowed:Record<string,unknown>={react:React,"@godot-js/react":sdk,"@playground/api":api};
      const load=(id:string)=>{if(!Object.prototype.hasOwnProperty.call(allowed,id))throw Error(`Unsupported module: ${id}`);return allowed[id];};
      new Function("require","module","exports",`${code}\n//# sourceURL=playground-demo.js`)(load,module,module.exports);
      if(typeof module.exports.default!=="function")throw Error("The demo must export a default React component");
      native=godot.createGodotPort(this,{rootId:"playground",rootInstance:`preview-${++this.generation}`});
      this.root=sdk.createRoot(native.port,native.containerKey,{generation:"playground",profileId:"showcase-v1",mode:mode==="development"?"development":"production",assets:{...manifest.assets,...this.projectAssets?.assets},onError:(error:unknown)=>this.fail(error)});
      const buses=Object.entries(this.projectAssets?.assets??{}).filter(([,value]:any)=>value.type==="AudioBusLayout").map(([id])=>id);if(buses.length){this.root.preloadAssets(buses);this.root.pump();}
      this.services={controls:{...controls},input:this.input,models:manifest.models,scenes:this.projectAssets?.scenes??{},stats:(stats:any)=>{this.stats=stats;},sound:(name:string)=>{if(this.sounds.length<16)this.sounds.push(name);},exportJSON:(name:string,data:unknown)=>this.event({type:"export-data",name,data})};
      this.services.Component=module.exports.default;
      this.render();this.event({type:"running",generation:this.generation});
    }catch(error){this.fail(error);try{if(native&&!this.root){native.port.beginStage("cleanup");try{native.port.quiesce();native.port.forceClose();}finally{native.port.endStage();}}}finally{this.stop();}}
  }
  private render(){
    const content=React.createElement(React.Suspense,{fallback:null},React.createElement(this.services.Component),...["jump","coin","land"].map(name=>React.createElement(api.Sound,{key:name,name,events:this.sounds})));
    this.root.render(React.createElement(api.Services.Provider,{value:{...this.services}},content));
  }
  private controls(values:Record<string,number>){if(this.root&&this.services){this.services.controls={...values};this.render();}}
  private clearInput(){if(this.root)this.root.input({type:"InputReset"});this.input.keys.clear();this.input.pressed.clear();this.input.actions.clear();this.input.down=false;this.input.clicks.length=0;this.input.releases.length=0;this.input.wheel=0;}
  private stop(){let cleanup:any;try{if(this.root){try{this.root.shutdown("playground-stop");cleanup=this.root.getStats();}finally{this.root=undefined;}}}finally{const resourceCleanup=this.projectAssets?.dispose();this.projectAssets=undefined;this.services=undefined;if(resourceCleanup?.failures)this.fail(Error("E_RESOURCE_CLEANUP: could not remove generated resources"));this.event({type:"stopped",cleanup,resourceCleanup,failed:!!this.failure});}}
  private fail(error:unknown){if(this.failure)return;this.failure=error;const message=String(error),stack=(error as any)?.stack??"";this.event({type:"runtime-error",message,stack});console.error("PLAYGROUND_ERROR",message,stack);}
  private inspect(){return {state:this.root?.state??"stopped",generation:this.generation,frames:this.frames,stats:this.stats,tree:this.root?.getHostGraph()??[],resources:this.root?.getStats()??{},errors:this.root?.getErrors().map(String)??[]};}
  _process(dt:number){
    if(!this.root){if(this.verify&&this.failure)invoke(invoke(this,"get_tree"),"quit",1);return;}
    try{this.root.pump(dt);if(this.failure||this.root.state==="faulted")throw this.failure??Error("Root faulted");this.root.process(dt);this.frames++;this.elapsed+=dt;
      if(this.elapsed>.1){this.event({type:"stats",...this.inspect(),fps:Math.round(1/Math.max(dt,.001))});this.elapsed=0;}
      if(this.verify&&this.frames===180){const result=this.inspect();if(result.state!=="running"||result.errors.length)throw Error(JSON.stringify(result));console.log("PLAYGROUND_VERIFIED "+JSON.stringify(result));this.stop();invoke(invoke(this,"get_tree"),"quit",0);}
    }catch(error){this.fail(error);this.stop();if(this.verify)invoke(invoke(this,"get_tree"),"quit",1);}
    this.input.actions.clear();this.input.requests.clear();this.input.clicks.length=0;this.input.releases.length=0;this.input.wheel=0;
  }
  _physics_process(dt:number){if(this.root){try{this.root.physics(dt);}catch(error){this.fail(error);this.stop();}}this.input.pressed.clear();}
  _unhandled_input(event:any){if(this.root){try{this.root.input(godot.snapshotInputEvent(event),"unhandled");}catch(error){this.fail(error);this.stop();}}}
  _input(event:any){
    if(this.root){try{this.root.input(godot.snapshotInputEvent(event));}catch(error){this.fail(error);this.stop();return;}}
    const kind=String(invoke(event,"get_class"));
    if(kind==="InputEventKey"){
      const key=Number(event.physical_keycode??event.physicalKeycode??event.keycode),code=key===32?"Space":key>=65&&key<=90?`Key${String.fromCharCode(key)}`:key>=48&&key<=57?`Digit${key-48}`:({4194312:"Delete",4194319:"ArrowLeft",4194321:"ArrowRight",4194320:"ArrowUp",4194322:"ArrowDown"} as Record<number,string>)[key]??"";
      if(code){if(event.pressed){this.input.keys.add(code);if(!event.echo){this.input.pressed.add(code);this.input.actions.add(code);}}else this.input.keys.delete(code);}
    }
    if(kind==="InputEventMouseMotion"||kind==="InputEventMouseButton"){this.input.pointer={x:event.position.x,y:event.position.y};if(kind==="InputEventMouseButton"){const button=Number(event.button_index??event.buttonIndex);if(button===1)this.input.down=event.pressed;if(button===4||button===5){if(event.pressed)this.input.wheel+=button===4?-1:1;}else{const list=event.pressed?this.input.clicks:this.input.releases;if(list.length<32)list.push({...this.input.pointer,button});}}}
  }
  _exit_tree(){this.stop();delete world.__godotPlayground;}
}

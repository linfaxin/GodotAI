// Engine-only QA adapter. The React application above sees only read handles,
// static tokens and DTOs; this adapter owns ENet setup and native metadata checks.
declare const require:(name:string)=>any;
declare const console:{log(...values:unknown[]):void;error(...values:unknown[]):void};
const G=require("godot");
const nativeText=(value:any):string=>typeof value==="string"?value:String(G.str(value));
const connect=(signal:any,callback:(...args:any[])=>void)=>signal.connect(G.Callable.create(callback));
const member=(object:any,name:string)=>object[name]??object[name.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase())];
const call=(object:any,name:string,...args:any[])=>{
  const method=member(object,name);
  if(typeof method==="function")return method.apply(object,args);
  const property=name.startsWith("get_")?name.slice(4):name.startsWith("is_")?name.slice(3):name.startsWith("set_")?name.slice(4):undefined;
  if(property){const camel=property.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase()),key=property in object?property:camel in object?camel:undefined;if(key){if(name.startsWith("set_")&&args.length===1){object[key]=args[0];return;}if(!args.length)return object[key];}}
  throw Error(`Missing engine method ${name}`);
};
export function start(controller:any,module:any,nativeRoot?:any):Promise<unknown> {
  return new Promise((resolve,reject)=>{
  // Engine.get_main_loop is statically wrapped as MainLoop; Object.get reads
  // the SceneTree property and Node.get_tree returns a SceneTree-typed wrapper.
  nativeRoot??=call(call(G.Engine,"get_main_loop"),"get","current_scene");
  const packed=call(G.OS,"get_cmdline_user_args");
  const args=(Array.isArray(packed)?packed:typeof packed.size==="function"?Array.from({length:call(packed,"size")},(_,index)=>call(packed,"get_indexed",index)):Array.from(packed)) as string[];
  if(args.includes("--godot-react-verify")){resolve({framework:true});return;}
  const role=args.find(arg=>arg.startsWith("--role="))?.slice(7),port=Number(args.find(arg=>arg.startsWith("--port="))?.slice(7));
  const mode=controller.root.options.mode,expectedMode=args.find(arg=>arg.startsWith('--expected-mode='))?.slice(16);
  const initialLifecycle={...module.lifecycle};
  let peer:any,round=0,requests=0,replies=0,local=0,unreliable=0,ready=0,finished=false,disconnects=0;
  const tree=call(nativeRoot,"get_tree"),api=call(nativeRoot,"get_multiplayer");
  const log=(event:string,data:unknown={})=>console.log("REACT_NATIVE_RPC "+JSON.stringify({event,role,data}));
  const quit=(ok:boolean,message:string)=>{if(finished)return;finished=true;const result={message,requests,replies,local,unreliable,ready,disconnects,mode,initialLifecycle,lifecycle:{...module.lifecycle},frames:{...module.frames}};log(ok?"OK":"FAILED",result);if(ok)resolve(result);else reject(Error(message));};
  const check=(condition:unknown,message:string)=>{if(!condition)throw Error(message);};
  const timer=(seconds:number,fn:()=>void)=>connect(call(tree,"create_timer",seconds).timeout,()=>{try{fn();}catch(error){quit(false,String(error));}});
  const send=(method:string,values:unknown[],peerId?:number)=>{check(module.endpoint,"Hook sender unavailable");const result=module.endpoint.send(method,values,{peerId});check(result.localError===0,`${method} localError ${result.localError}`);};
  const connectClient=()=>{
    peer=new G.ENetMultiplayerPeer();check(call(peer,"create_client","127.0.0.1",port,3)===0,"ENet client create failed");call(api,"set_multiplayer_peer",peer);
  };
  const metadataCheck=()=>{
    const node=call(nativeRoot,"get_node","Endpoint"),script=call(node,"get_script"),metadata=call(script,"get_rpc_config");
    check(call(node,"get_class")==="Node2D","Exact native leaf changed");
    const config=(method:string,key:string)=>call(call(metadata,"get_keyed",method),"get_keyed",key);
    check(config("rpcPing","rpc_mode")===1&&config("rpcReply","rpc_mode")===2,"RPC authority metadata mismatch");
    check(config("rpcLocal","call_local")===true&&config("rpcLocal","channel")===1,"call_local/channel metadata mismatch");
    check(config("rpcUnreliable","transfer_mode")===1&&config("rpcUnreliable","channel")===2,"unreliableOrdered/channel metadata mismatch");
    log("METADATA",{type:call(node,"get_class"),path:nativeText(call(node,"get_path")),script:String(member(script,"resource_path"))});
    return {node,script};
  };
  if(args.includes("--godot-react-business-verify")&&!role){
    timer(0.05,()=>{metadataCheck();check(module.events.some((event:any)=>event.method==="_ready"),"Packed native ready handler missing");quit(true,"packed native interface metadata and handler ready; network gate is a separate two-process run");});return;
  }
  const poll=()=>{
    if(finished)return;
    try{
      for(const event of module.events.splice(0)){
        if(event.method==="_ready"){ready++;check(ready===1,"Native ready replayed after React update");}
        if(event.method==="rpcAuthority")throw Error("Authority-negative request executed");
        if(event.method==="rpcMissingChannel")throw Error("RPC on an unnegotiated channel executed");
        if(event.method==="rpcLocal")local++;
        if(event.method==="rpcUnreliable")unreliable++;
        if(event.method==="_input")check(event.args[0].type==="InputEventAction"&&event.args[0].pressed===true&&Object.isFrozen(event.args[0]),"InputEvent was not converted to immutable DTO");
        if(event.method==="rpcPing"){
          check(role==="server","Ping executed on wrong peer");requests++;const request=event.args[0];
          check(request.round===requests&&request.path===nativeText(call(call(nativeRoot,"get_node","Endpoint"),"get_path"))&&event.args[1]==="player:stable","Request DTO, network ID or native path mismatch");
          const context=event.args[2];check(context.senderPeerId===request.peerId,"Native sender context lost across queueing");
          send("rpcReply",[{round:request.round,path:request.path}],context.senderPeerId);
          if(requests===2)timer(0.3,()=>{check(local===2&&unreliable>0&&ready===1&&disconnects>=1&&module.frames.process>0&&module.frames.physics>0&&module.frames.input>0,"Server channel, per-node callbacks, ready or reconnect assertion failed");quit(true,"server received both requests; authority, wrong path and unnegotiated channel never applied");});
        }
        if(event.method==="rpcReply"){
          check(role==="client","Reply executed on wrong peer");replies++;
          check(event.args[0].round===replies&&event.handlerRound===round&&event.args[1].senderPeerId===1,"Reply DTO, sender or newest committed handler mismatch");
          if(replies===1){timer(0.08,()=>{call(peer,"close");timer(0.15,()=>{round=2;controller.render({round});connectClient();});});}
          else timer(0.08,()=>{check(local===2&&ready===1&&module.frames.process>0&&module.frames.physics>0&&module.frames.input>0,"call_local, per-node callbacks or ready failed");quit(true,"client DTO reply, local call, channel and reconnect verified");});
        }
      }
    }catch(error){quit(false,String(error));return;}
    timer(0.01,poll);
  };
  try{
    check(role==="server"||role==="client","Specify --role=server|client");check(port>0&&port<65536,"Invalid port");
    check(expectedMode===mode,"Requested source/PCK mode differs from runtime mode");
    if(mode==='development')check(initialLifecycle.renders>=2&&initialLifecycle.layoutMounts>=2&&initialLifecycle.layoutCleanups>=1,"Development StrictMode did not replay committed layout effects");
    else check(mode==='production'&&initialLifecycle.layoutMounts===1&&initialLifecycle.layoutCleanups===0,"Production unexpectedly replayed committed layout effects");
    log('STRICT_MODE',{mode,replayed:mode==='development',...initialLifecycle});
    metadataCheck();
    connect(member(api,"peer_disconnected"),()=>{disconnects++;});
    connect(member(api,"connected_to_server"),()=>{
      try{if(!round)round=1;controller.render({round,wrong:round===1});const path=nativeText(call(call(nativeRoot,"get_node","Endpoint"),"get_path"));
        // Error is a local send status; authority is checked by the receiving peer.
        const denied=module.endpoint.send("rpcAuthority",["unauthorized-client"],{peerId:1});log("AUTHORITY_SENT",denied);
        const missing=module.endpoint.send("rpcMissingChannel",[round],{peerId:1});log("MISSING_CHANNEL_SENT",missing);
        if(round===1){
          // This client-only React child has no matching path on the server.
          const status=module.wrongEndpoint.send("rpcPing",[{round:999,path:path.replace(/\/Endpoint$/,"/WrongEndpoint"),peerId:call(api,"get_unique_id")},"player:stable"],{peerId:1});log("WRONG_PATH_SENT",status);
          timer(0.1,()=>controller.render({round,wrong:false}));
        }
        send("rpcPing",[{round,path,peerId:call(api,"get_unique_id")},"player:stable"],1);
        send("rpcLocal",[round]);for(let i=0;i<3;i++)send("rpcUnreliable",[round],1);
      }catch(error){quit(false,String(error));}
    });
    if(role==="server"){peer=new G.ENetMultiplayerPeer();call(peer,"set_bind_ip","127.0.0.1");check(call(peer,"create_server",port,2,3)===0,"ENet server create failed");call(api,"set_multiplayer_peer",peer);log("LISTEN",{port});}
    else connectClient();
    timer(0.06,()=>{const event=new G.InputEventAction();call(event,"set_action","ui_accept");call(event,"set_pressed",true);call(G.Input,"parse_input_event",event);});
    timer(12,()=>quit(false,"RPC fixture timed out"));poll();
  }catch(error){quit(false,String(error));}
  });
}

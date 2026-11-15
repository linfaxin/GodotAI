import * as G from 'godot';
import React from 'react';
import {createRoot,EngineNode} from '@godot-js/react/engine';

const host=(globalThis as any).__godotjsRuntimeHost;
const valid=(object:any)=>{try{return G.is_instance_valid(object);}catch{return false;}};
const requireValue=(value:boolean,message:string)=>{if(!value)throw Error('WORKER_RAW_SIGNAL_BARRIER '+message);};

export default class Main extends G.Node2D {
 frames=0;
 _process(){
  if(++this.frames!==20)return;
  requireValue(typeof (globalThis as any).document==='undefined'&&host.role==='engine','must execute in the engine Worker');
  const mount=new G.Node();
  const root=createRoot(mount,{autoProcess:false});
  let button:any;
  root.render(React.createElement(EngineNode,{ctor:G.Button,ref:(value:any)=>{if(value)button=value;}}));
  root.flush();
  requireValue(valid(button),'Button must materialize before the raw signal');
  const phases:any[]=[];
  const callable=G.Callable.create(()=>{
   root.unmount();root.flush();
   const stats=root.getStats();
   phases.push({phase:'inside-raw-native-signal',valid:valid(button),stats});
   requireValue(valid(button)&&stats.releaseRequested===0&&stats.freed===0,'flush released the native signal emitter inside its callback');
  });
  // Deliberately use the public native signal API, without renderer on props.
  button.pressed.connect(callable);
  button.emit_signal('pressed');
  const sameStack=root.getStats();
  phases.push({phase:'after-native-emit-same-stack',valid:valid(button),stats:sameStack});
  requireValue(valid(button)&&sameStack.releaseRequested===0&&sameStack.freed===0,'native emitter was released before the authored stack returned');
  Promise.resolve().then(()=>{
   const stats=root.getStats();
   phases.push({phase:'after-private-promise-checkpoint',valid:valid(button),stats});
   requireValue(!valid(button)&&stats.releaseRequested===1&&stats.freed===1&&stats.pendingReleases===0&&stats.cleanExit,'native release did not complete exactly once at the private checkpoint');
   root.shutdown();root.flush();
   return Promise.resolve().then(()=>{
    const finalStats=root.getStats();
    requireValue(finalStats.releaseRequested===1&&finalStats.freed===1&&finalStats.cleanExit,'repeated cleanup released twice or marked a false clean result');
    mount.free();
    return this.foreignTransfer().then(foreign=>host.emitProjectEvent({type:'raw-native-signal-barrier',passed:true,documentAbsent:true,role:host.role,phases,finalStats,foreign}));
   });
  });
 }
 foreignTransfer(){
  const mount=new G.Node(),outside=new G.Node(),errors:any[]=[];
  const root=createRoot(mount,{autoProcess:false,onError:(error:any,info:any)=>errors.push({message:String(error),kind:info.kind})});
  let button:any,retiring=false,moved=false;
  root.render(React.createElement(EngineNode,{ctor:G.Button,ref:(value:any)=>{if(value)button=value;}}));root.flush();
  const callable=G.Callable.create(()=>{
   if(retiring&&!moved&&valid(button)&&button.get_parent()===null){moved=true;outside.add_child(button);}
  });
  mount.child_order_changed.connect(callable);
  retiring=true;root.unmount();root.flush();
  requireValue(moved&&valid(button)&&button.get_parent()===outside,'remove_child callback must transfer the native object to its external parent');
  return Promise.resolve().then(()=>{
   const stats=root.getStats(),observation={moved,valid:valid(button),parentIsOutside:valid(button)&&button.get_parent()===outside,stats,errors};
   requireValue(observation.valid&&observation.parentIsOutside&&stats.releaseRequested===0&&stats.freed===0&&!stats.cleanExit,'retirement stole or released the native object after a foreign transfer');
   requireValue(errors.some(error=>error.message.includes('E_ENGINE_STRUCTURE')),'foreign transfer must remain an observed structure failure');
   root.shutdown();root.flush();outside.free();mount.free();return observation;
  });
 }
}

// Native QA for the direct renderer's ownership boundary. This file is selected
// explicitly by the integration harness, not imported by the application.
declare const require:(name:string)=>any;
const G=require('godot');
const call=(object:any,name:string,...args:any[])=>{const method=object[name]??object[name.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase())];if(typeof method==='function')return method.apply(object,args);if(!args.length&&(name.startsWith('get_')||name.startsWith('is_'))){const key=name.slice(name.startsWith('get_')?4:3),value=object[key]??object[key.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase())];if(value!==undefined)return value;}throw Error('Missing native method '+name);};
const ensure=(condition:unknown,message:string)=>{if(!condition)throw Error('E_ISLAND_QA: '+message);};
export async function start(controller:any):Promise<unknown>{
 const launcher=call(call(G.Engine,'get_main_loop'),'get','current_scene'),tree=call(launcher,'get_tree'),managed=call(launcher,'get_node','App');
 const wait=()=>new Promise<void>(resolve=>call(call(tree,'create_timer',.02).timeout,'connect',G.Callable.create(()=>resolve())));
 const args=call(G.OS,'get_cmdline_user_args'),values=Array.isArray(args)?args:Array.from({length:call(args,'size')},(_,index)=>call(args,'get_indexed',index));
 const foreign=new G.Node();foreign.name='IndependentNativeSibling';
 if(values.includes('--island-managed-injection')){
  const original=controller.root.options.onError;let observed=false;
  controller.root.options.onError=(error:unknown,info:any)=>{
   if(String(error).includes('E_ENGINE_STRUCTURE')&&!observed){observed=true;
    ensure(G.is_instance_valid(managed)&&G.is_instance_valid(foreign),'foreign mutation destroyed the affected island');
    ensure(call(foreign,'get_parent')===managed&&!controller.root.isNativeOwned(foreign),'an unknown native child was adopted');
    original?.(error,info);
    void controller.root.close().then((result:any)=>{
     ensure(result.status!=='complete','an ownership violation was reported as clean');
     ensure(G.is_instance_valid(managed)&&G.is_instance_valid(foreign)&&call(foreign,'get_parent')===managed,'quarantined native island was destroyed during close');
     console.log('GODOT_REACT_ISLAND_RETAINED '+JSON.stringify({status:result.status,unknownChildRetained:true,managedIslandRetained:true,unknownChildUnclaimed:true}));
    });return;
   }
   original?.(error,info);
  };
  foreign.name='UnregisteredManagedChild';call(managed,'add_child',foreign);
  await new Promise<void>(()=>{});return undefined;
 }
 call(call(tree,'get_root'),'add_child',foreign);console.log('GODOT_REACT_ISLAND_SIBLING_ADDED');await wait();await wait();
 ensure(controller.root.getErrors().length===0&&controller.root.getStats().orphaned===0,'unrelated native sibling faulted the managed island');
 console.log('GODOT_REACT_ISLAND_CLOSE_BEGIN');const result=await controller.root.close();console.log('GODOT_REACT_ISLAND_CLOSE_RESULT '+JSON.stringify(result));ensure(result.status==='complete','ordinary root close did not complete');
 ensure(G.is_instance_valid(foreign)&&call(foreign,'get_parent')===call(tree,'get_root'),'closing React freed an independent native sibling');
 call(foreign,'free');
 return {independentSiblingCoexists:true,rootCloseComplete:true,independentSiblingSurvivesRootClose:true};
}

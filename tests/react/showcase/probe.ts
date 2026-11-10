// Bundled by scripts/test/showcase-native.mjs; run against the actual C++ bridge.
declare const require:(id:string)=>any;
const G=require('godot');
import * as React from '../../../scripts/jsb.react/node_modules/react';
import { createRoot } from '../../../scripts/jsb.react/dist';
import { SHOWCASE_HOST_SCHEMA } from '../../../scripts/jsb.react/dist/schema/showcase';
import { orderedPropertyNames } from '../../../scripts/jsb.react/dist/schema/validation';
import { createGodotPort } from '../../../scripts/jsb.react/dist/godot';
const invoke=(o:any,n:string,...args:any[]) => (o[n]??o[n.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase())]).apply(o,args);
export default class Probe extends G.Node {
  _ready(){
    let native:any;
    try{
      native=createGodotPort(this,{rootId:'showcase-native',rootInstance:'probe'});
      const port=native.port;
      let count=0,properties=0,signals=0;
      port.beginStage('initial');
      for(const [type,schema] of Object.entries(SHOWCASE_HOST_SCHEMA)){
        const methods=JSON.parse(String(invoke(G.JSON,'stringify',invoke(G.ClassDB,'class_get_method_list',type))));
        for(const command of Object.values(schema.commands)){
          if(command.nativeName.startsWith('__react_'))continue;
          const method=methods.find((m:any)=>m.name===command.nativeName);
          if(!method)throw Error(type+'.'+command.nativeName+' is missing');
          const argc=command.arguments.length;
          if(argc>method.args.length||argc<method.args.length-method.default_args.length)throw Error(type+'.'+command.nativeName+' argument count differs from native');
        }
        const key=port.create(type);
        for(const name of orderedPropertyNames(type,'showcase-v1')){
          const property=schema.properties[name]!;
          if(property.construction)continue;
          // Exercise every declared property through verified native setter acknowledgements.
          const value=property.codec==='colorArray'?{kind:'PackedColorArray',values:property.defaultValue}:property.codec==='vector2i'?{...property.defaultValue as object,kind:'Vector2i'}:property.codec==='vector2Array'||property.codec==='vector3Array'?{kind:property.codec==='vector2Array'?'PackedVector2Array':'PackedVector3Array',values:property.defaultValue}:property.defaultValue;
          try{port.set(key,property.nativeName,value);}catch(error){throw Error(type+"."+name+": "+String(error));}properties++;
        }
        for(const signal of Object.values(schema.signals)){port.connect(key,signal.nativeName,()=>{});signals++;}
        port.free(key);count++;
      }
      const particles=port.create('CPUParticles2D');
      port.endStage();port.beginStage('physics');
      let phaseRejected=false;
      try{port.command(particles,'restart',[]);}catch(error){phaseRejected=String(error).includes('E_COMMAND_PHASE');}
      if(!phaseRejected)throw Error('particle restart escaped process phase');
      port.endStage();port.beginStage('process');port.command(particles,'restart',[]);
      port.endStage();port.beginStage('safe');port.free(particles);
      const timer=port.create('Timer');port.set(timer,'wait_time',.01);
      port.append(native.containerKey,timer,0);
      port.endStage();
      port.beginStage('process');port.command(timer,'start',[.01]);
      if(port.command(timer,'is_stopped',[])!==false)throw Error('timer failed to start');
      port.command(timer,'stop',[]);
      if(port.command(timer,'is_stopped',[])!==true)throw Error('timer failed to stop');
      port.endStage();
      port.beginStage('cleanup');port.remove(native.containerKey,timer);port.free(timer);port.quiesce();port.endStage();port.close();native=undefined;
      native=createGodotPort(this,{rootId:'showcase-mounted',rootInstance:'mounted'});
      const root=createRoot(native.port,native.containerKey,{generation:'native-probe',profileId:'showcase-v1',mode:'production'});
      try{
        for(const type of Object.keys(SHOWCASE_HOST_SCHEMA)){
          root.render(React.createElement(type,{name:'Mounted_'+type}));root.pump(.016);
          if(root.getErrors().length)throw root.getErrors()[0];
          root.render(null);root.pump(.016);
        }
      }finally{root.shutdown();native=undefined;}
      console.log('SHOWCASE_NATIVE_OK '+JSON.stringify({hosts:count,properties,signals}));
      invoke(invoke(this,'get_tree'),'quit',0);
    }catch(error){console.error('SHOWCASE_NATIVE_FAILED',String(error),(error as any).stack);if(native){try{native.port.forceClose();}catch{}}invoke(invoke(this,'get_tree'),'quit',1);}
  }
}

// Small metadata fixture for pure consumer contracts. Actual release validation
// additionally captures the target Web engine and checks every declaration.
export function engineApiFixture(){
 const property=(nativeName,type,extra={})=>({nativeName,publicName:nativeName,type,class_name:'',hint:0,hint_string:'',usage:6,...extra});
 const method=(nativeName,args=[],type=0,extra={})=>({nativeName,publicName:nativeName,args,return:property('',type),flags:0,defaultArgs:[],hasReturnValue:type!==0,...extra});
 const nativeClass=(nativeName,parent,methods=[],properties=[],signals=[],extra={})=>({nativeName,publicName:nativeName,parent,apiType:0,exposed:true,enabled:true,constructible:true,abstract:false,virtual:false,methods,properties,signals,constants:[],enums:[],...extra});
 const global=(nativeName,integer,enumeration)=>({nativeName,publicName:nativeName,integer:String(integer),enum:enumeration,enumPublicName:enumeration,enumValueName:nativeName});
 const names=['Nil','bool','int','float','String','Vector2','Vector2i','Rect2','Rect2i','Vector3','Vector3i','Transform2D','Vector4','Vector4i','Plane','Quaternion','AABB','Basis','Transform3D','Projection','Color','StringName','NodePath','RID','Object','Callable','Signal','Dictionary','Array','PackedByteArray','PackedInt32Array','PackedInt64Array'];
 const builtins=names.map((nativeName,type)=>({nativeName,publicName:nativeName==='Array'?'GArray':nativeName==='Dictionary'?'GDictionary':nativeName,type,keyed:false,constructors:[method(nativeName)],methods:[],properties:[],constants:[],enums:[],operators:[]}));
 builtins[5].constructors.push(method('Vector2',[property('x',3),property('y',3)]));builtins[5].properties=[property('x',3),property('y',3)];
 builtins[5].bindingOperators=[{publicName:'ADD',leftType:5,rightType:5,returnType:5,unary:false},{publicName:'NEGATE',leftType:5,rightType:0,returnType:5,unary:true}];
 builtins[5].elementType=3;builtins[5].bindingExtras={getIndexed:'get_indexed',setIndexed:'set_indexed',builtinType:'__builtin_type__'};
 builtins[4].bindingKind='utility';builtins[4].methods=[method('length_',[],2)];
 builtins[29].bindingExtras={toArrayBuffer:'to_array_buffer'};
 builtins[27].bindingExtras={getKeyed:'get_keyed',setKeyed:'set_keyed'};
 builtins[26].methods=[method('connect',[property('callback',25)],2,{return:property('',2,{class_name:'Error'})}),method('disconnect',[property('callback',25)]),method('emit',[],0,{flags:16})];
 builtins[25].methods=[method('call',[],0,{flags:16,hasReturnValue:true}),method('callv',[property('args',28)],0,{hasReturnValue:true})];
 builtins[28].methods=[method('get',[property('index',2)],0,{hasReturnValue:true}),method('push_back',[property('value',0)])];
 builtins[27].methods=[method('get',[property('key',0)],0,{hasReturnValue:true}),method('set',[property('key',0),property('value',0)],1)];
 builtins[31].methods=[method('push_back',[property('value',2)]),method('get',[property('index',2)],2)];
 const nodeMode={nativeName:'ProcessMode',publicName:'ProcessMode'};
 const node=nativeClass('Node','Object',[
  method('add_child',[property('child',24,{class_name:'Node'}),property('readable',1)],0,{defaultArgs:[{type:1,value:false,text:'false'}]}),
  method('get_name',[],4),method('set_name',[property('name',4)]),
  method('get_process_mode',[],2,{return:property('',2,{class_name:'Node.ProcessMode'})}),
  method('_ready'),method('_process',[property('delta',3)]),
 ],[property('name',4,{binding:'methods',getter:'get_name',setter:'set_name'}),property('process_mode',2,{binding:'property',getter:'get_process_mode',setter:'set_process_mode',hint:2,hint_string:'Inherit,Paused'})],[method('child_entered_tree',[property('node',24,{class_name:'Node'})])],{enums:[nodeMode],constants:[{nativeName:'PROCESS_MODE_INHERIT',publicName:'PROCESS_MODE_INHERIT',enum:'ProcessMode',integer:'0'},{nativeName:'PROCESS_MODE_PAUSED',publicName:'PROCESS_MODE_PAUSED',enum:'ProcessMode',integer:'1'}]});
 return{schemaVersion:1,apiVersion:'godotjs-engine-api/1',namingVersion:'godotjs-public-names/1',engineVersion:'test-fixture',bindingVersion:'1.0.0',bindingNaming:'snake',platform:'Web',modules:['GodotJS','gdscript'],bindingPolicy:{excludeGetSetMethods:true,bigInt:true,sharedResources:true},classes:[
  nativeClass('Object','',[method('free'),method('get_instance_id',[],2)]),node,
  nativeClass('Node2D','Node',[method('translate',[property('offset',5)])],[property('position',5,{binding:'property',getter:'get_position',setter:'set_position'})]),
  nativeClass('Timer','Node',[],[property('time_left',3,{binding:'property',getter:'get_time_left',setter:''})]),
  nativeClass('Engine','Object',[method('has_singleton',[property('name',4)],1)],[],[],{constructible:false,abstract:true}),
 ],builtins,utilities:[method('is_instance_valid',[property('object',0)],1)],globalConstants:[global('OK',0,'Error'),global('TYPE_INT',2,'Variant.Type'),global('PROPERTY_HINT_NONE',0,'PropertyHint'),global('PROPERTY_USAGE_DEFAULT',6,'PropertyUsageFlags')],singletons:[{nativeName:'Engine',publicName:'Engine',className:'Engine'}]};
}

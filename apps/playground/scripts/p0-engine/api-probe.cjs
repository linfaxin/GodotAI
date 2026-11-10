// Executable on both the existing baseline and the instrumented full Web template.
const G = require('godot');
const J = require('godot-jsb');
const names = J.internal.names;
const publicMember = name => names.get_member(name);
const type = name => G[names.get_class(name)];
const call = (object, name, ...args) => {
  const key = publicMember(name);
  const fn = object[key] ?? object[name];
  if (typeof fn !== 'function') throw Error('Missing native method ' + name + ' / ' + key);
  return fn.apply(object, args);
};
const sequence = value => Array.from({length:Number(call(value,'size'))}, (_,i) => {
  const getter = value[publicMember('get_indexed')] ?? value[publicMember('get')];
  return getter.call(value,i);
});
const field = (value,key) => call(value,'get',key);
const attach = (name,value) => {
  if (!call(type('OS'),'has_feature','web')) return;
  const window = call(type('JavaScriptBridge'),'get_interface','window');
  call(window,'call','__p0Attach',name,value);
};
const plain = (value, depth=0) => {
  if(depth>20) return {kind:'depth-limit'};
  if(value===null || typeof value==='undefined' || ['string','number','boolean'].includes(typeof value))return value??null;
  if(typeof value==='bigint')return {kind:'int64',decimal:value.toString()};
  if(Array.isArray(value))return value.map(v=>plain(v,depth+1));
  if(typeof value[publicMember('keys')]==='function'){
    const out={};for(const key of sequence(call(value,'keys')))out[String(key)]=plain(field(value,key),depth+1);return out;
  }
  if(typeof value[publicMember('size')]==='function')return sequence(value).map(v=>plain(v,depth+1));
  return {kind:'native-default',type:call(G,'typeof',value),text:String(call(G,'var_to_str',value))};
};

exports.runApiProbe = function runApiProbe(host, options={}) {
  console.log('P0_API_PROGRESS collect-class-list');
  const checks={},observations={},failures=[];
  const check=(name,run)=>{try{const result=run();checks[name]=result===true;if(result!==true&&!Object.hasOwn(observations,name))observations[name]=result;}catch(error){checks[name]=false;failures.push({name,error:String(error),stack:error?.stack});}};
  const classNames=sequence(call(type('ClassDB'),'get_class_list')).map(String).filter(v=>v!=='P0EngineApiProbe').sort();
  const singletonNames=sequence(call(type('Engine'),'get_singleton_list')).map(String).sort();
  const instrumented=call(type('ClassDB'),'class_exists','P0EngineApiProbe');
  const camel=!!call(type('ProjectSettings'),'get_setting','GodotJS/runtime/core/camel_case_bindings_enabled',false);
  let ir;
  console.log('P0_API_PROGRESS metadata '+JSON.stringify({instrumented,classes:classNames.length,camel}));
  if(instrumented)ir=JSON.parse(call(type('P0EngineApiProbe'),'describe_json'));
  else ir={schemaVersion:1,instrumentation:null,classes:classNames.map(name=>({name,parent:String(call(type('ClassDB'),'get_parent_class',name)),constructible:call(type('ClassDB'),'can_instantiate',name),methods:plain(call(type('ClassDB'),'class_get_method_list',name,true)),properties:plain(call(type('ClassDB'),'class_get_property_list',name,true)),signals:plain(call(type('ClassDB'),'class_get_signal_list',name,true))})),singletons:singletonNames.map(name=>({name})),builtins:[],utilities:[],global_constants:[]};
  ir.bindingNaming=camel?'camel':'snake';
  console.log('P0_API_PROGRESS metadata-collected');
  const memberNames=new Set(),classStatuses=[];
  for(const cls of ir.classes){
    cls.publicName=names.get_class(cls.name);
    let bindable=false,error;
    try{bindable=!!G[cls.publicName];}catch(e){error=String(e);}
    classStatuses.push({name:cls.name,publicName:cls.publicName,mappedOriginalName:names.get_internal_mapping(cls.publicName),registered:true,bindable,constructible:!!cls.constructible,...(error?{error}:{})});
    for(const kind of ['methods','properties','signals'])for(const member of cls[kind]??[]){member.publicName=publicMember(member.name);memberNames.add(member.name);if(kind==='properties')member.jsBinding=member.name==='name'?{kind:'methods',reason:'GodotJS StringNames ignores name to avoid JS class-name conflicts'}:{kind:'property'};}
  }
  for(const builtin of ir.builtins){
    builtin.publicName=names.get_class(builtin.name);
    for(const kind of ['methods','properties'])for(const member of builtin[kind]??[]){member.publicName=publicMember(member.name);memberNames.add(member.name);}
  }
  for(const utility of ir.utilities)utility.publicName=publicMember(utility.name);
  console.log('P0_API_PROGRESS class-binding-collected');
  ir.bindingStatus=classStatuses;
  observations.classCount=classNames.length;
  observations.bindableClasses=classStatuses.filter(v=>v.bindable).length;
  check('classNameRoundtrip',()=>classStatuses.every(v=>v.mappedOriginalName===v.name));
  observations.classNameMappingMismatches=classStatuses.filter(v=>v.mappedOriginalName!==v.name);
  observations.unbindableClasses=classStatuses.filter(v=>!v.bindable);
  observations.singletonCount=singletonNames.length;
  observations.builtinCount=ir.builtins.length;
  observations.utilityCount=ir.utilities.length;
  observations.globalConstantCount=ir.global_constants.length;
  observations.instrumented=instrumented;
  observations.naming={mode:ir.bindingNaming,classGetMethodList:publicMember('class_get_method_list'),nodeName:publicMember('name'),meshInstance3D:names.get_class('MeshInstance3D')};
  observations.newModuleClasses={};
  for(const name of ['FastNoiseLite','NoiseTexture2D','ZIPReader','ENetMultiplayerPeer','WebSocketPeer','CSGBox3D','MovieWriter']){
    observations.newModuleClasses[name]={registered:classNames.includes(name),bindable:classStatuses.find(v=>v.name===name)?.bindable??false};
  }
  observations.editorMetadata={};
  for(const name of ['get_classes','get_primitive_types','get_utility_functions','get_global_constants','get_singletons']){
    try{const value=J.editor[name]();observations.editorMetadata[name]={available:true,count:value.length};}catch(error){observations.editorMetadata[name]={available:false,error:String(error)};}
  }
  check('classMetadata',()=>{
    const cls=ir.classes.find(v=>v.name==='Node2D'),method=cls?.methods.find(v=>v.name==='set_position');
    return !!method?.args?.length&&Number(method.args[0].type)===Number(type('Variant').Type[names.get_enum_value('TYPE_VECTOR2')])&&!!cls.properties.find(v=>v.name==='position');
  });
  check('nativeVector',()=>{const v=new (type('Vector2'))(3,4);return call(v,'length')===5&&v.x===3&&v.y===4;});
  check('nativeTransform',()=>{const t=new (type('Transform2D'))(0,new (type('Vector2'))(7,9));return t.origin.x===7&&t.origin.y===9;});
  check('nativeColor',()=>{const v=new (type('Color'))(.25,.5,.75,1);return v.r===.25&&v.g===.5&&v.b===.75;});
  check('nodeIdentityAndNavigation',()=>{
    const child=new (type('Node2D'))();call(child,'set','name','IdentityChild');call(host,'add_child',child);
    const same=call(host,'get_node','IdentityChild')===child&&call(child,'get_parent')===host;
    call(child,'set','position',new (type('Vector2'))(7,9));
    const value=call(child,'get','position');call(host,'remove_child',child);call(child,'free');
    return same&&value.x===7&&value.y===9;
  });
  check('nativePropertyAccessors',()=>{
    const node=new (type('Node2D'))();call(node,'set','name','NativeAccessor');call(node,'set','position',new (type('Vector2'))(5,6));
    const nameKey=publicMember('name'),positionKey=publicMember('position');
    const inheritedRead=node[nameKey],ownRead=node[positionKey];
    node[nameKey]='WrittenThroughAccessor';node[positionKey]=new (type('Vector2'))(8,9);
    const nativeName=String(call(node,'get','name')),nativePosition=call(node,'get','position');
    const throughNameMethods=call(node,'get_name')==='NativeAccessor';
    const result=throughNameMethods&&ownRead?.x===5&&ownRead?.y===6&&nativeName==='NativeAccessor'&&nativePosition.x===8&&nativePosition.y===9;
    observations.nativePropertyAccessors={nameKey,positionKey,inheritedRead:inheritedRead??null,ownRead:ownRead?{x:ownRead.x,y:ownRead.y}:null,nativeName,nativePosition:{x:nativePosition.x,y:nativePosition.y},nameAccess:'intentional method-only binding; JS .name is an expando and not declared by existing codegen',throughNameMethods};
    call(node,'free');return result;
  });
  check('nativeObjectLifetime',()=>{const child=new (type('Node'))();call(child,'free');return call(G,'is_instance_valid',child)===false;});
  check('nativeObjectLifetimeAfterReallocation',()=>{
    const old=new (type('Node2D'))(),oldId=String(call(old,'get_instance_id'));
    call(old,'free');const immediatelyInvalid=call(G,'is_instance_valid',old)===false;
    const replacement=new (type('Node2D'))(),replacementId=String(call(replacement,'get_instance_id'));
    let oldValidAfterReuse,oldIdAfterReuse=null,oldReadError=null,oldWriteError=null;
    try{oldValidAfterReuse=call(G,'is_instance_valid',old);}catch(error){oldReadError=String(error);oldValidAfterReuse=false;}
    try{oldIdAfterReuse=String(call(old,'get_instance_id'));}catch(error){oldReadError=String(error);}
    try{call(old,'set','position',new (type('Vector2'))(123,456));}catch(error){oldWriteError=String(error);}
    const position=call(replacement,'get','position'),oldReferenceWroteReplacement=position.x===123&&position.y===456;
    observations.nativeObjectLifetimeAfterReallocation={oldId,replacementId,immediatelyInvalid,oldValidAfterReuse,oldIdAfterReuse,oldReadError,oldWriteError,oldReferenceWroteReplacement,jsIdentitySame:old===replacement};
    call(replacement,'free');return immediatelyInvalid&&!oldValidAfterReuse&&!oldReferenceWroteReplacement&&oldId!==replacementId;
  });
  check('sharedResourceIdentity',()=>{
    const material=new (type('StandardMaterial3D'))(),a=new (type('MeshInstance3D'))(),b=new (type('MeshInstance3D'))();
    call(a,'set','material_override',material);call(b,'set','material_override',material);
    call(material,'set','albedo_color',new (type('Color'))(0,1,0,1));
    const shared=call(a,'get','material_override')===material&&call(b,'get','material_override')===material&&call(call(b,'get','material_override'),'get','albedo_color').g===1;
    call(a,'free');call(b,'free');return shared;
  });
  check('arrayDictionaryAndPackedArray',()=>{
    const dictionary=new (type('Dictionary'))(),array=new (type('Array'))(),packed=new (type('PackedFloat32Array'))();
    call(packed,'push_back',1.25);call(packed,'push_back',2.5);call(array,'push_back',new (type('Vector2'))(2,3));call(dictionary,'set','array',array);call(dictionary,'set','packed',packed);
    const got=call(field(dictionary,'array'),'get',0);return got.x===2&&got.y===3&&call(field(dictionary,'packed'),'get',1)===2.5;
  });
  check('callableAndSignals',()=>{
    const timer=new (type('Timer'))();let count=0;const callable=type('Callable').create(()=>++count);
    const first=call(callable,'call');const connected=call(timer,'connect','timeout',callable);
    call(timer,'emit_signal','timeout');call(timer,'disconnect','timeout',callable);call(timer,'emit_signal','timeout');call(timer,'free');
    return first===1&&connected===0&&count===2;
  });
  for(const [name,value]of [['int64Positive',9007199254740993n],['int64Negative',-9007199254740993n]])check(name,()=>{
    const array=new (type('PackedInt64Array'))();call(array,'push_back',value);const got=call(array,'get',0);
    observations[name]={input:value.toString(),output:String(got),outputType:typeof got,exact:BigInt(got)===value};return BigInt(got)===value;
  });
  check('int64Boundaries',()=>{
    const values=[-9223372036854775808n,-9007199254740993n,-9007199254740991n,-2147483649n,0n,2147483648n,9007199254740991n,9007199254740993n,9223372036854775807n,-9007199254740991,-4294967297,-4294967295,-2147483649,-2147483648,0,2147483647,2147483648,4294967295,4294967296,9007199254740991];
    const results=[];
    for(const value of values){const array=new (type('PackedInt64Array'))();call(array,'push_back',value);const got=call(array,'get',0);results.push({input:value.toString(),inputType:typeof value,output:String(got),outputType:typeof got,exact:BigInt(got)===BigInt(value)});}
    observations.int64Boundaries=results;return results.every(v=>v.exact&&((BigInt(v.input)>9007199254740991n||BigInt(v.input)<-9007199254740991n)?v.outputType==='bigint':v.outputType==='number'));
  });
  check('int64NativeReturn',()=>{
    const results=[];for(const text of ['-9007199254740993','9007199254740993','-9223372036854775808','9223372036854775807']){const got=call(G,'str_to_var',text);results.push({input:text,output:String(got),outputType:typeof got,exact:BigInt(got)===BigInt(text)});}
    observations.int64NativeReturn=results;return results.every(v=>v.exact&&v.outputType==='bigint');
  });
  check('int64InvalidInputs',()=>{
    const results=[];for(const value of [9223372036854775808n,-9223372036854775809n,NaN,Infinity,-Infinity,9007199254740992,-9007199254740992]){const array=new (type('PackedInt64Array'))();let rejected=false;try{call(array,'push_back',value);}catch{rejected=true;}results.push({input:String(value),inputType:typeof value,rejected,size:Number(call(array,'size'))});}
    observations.int64InvalidInputs=results;return results.every(v=>v.rejected&&v.size===0);
  });
  check('resourceInstanceId',()=>{
    const resource=new (type('StandardMaterial3D'))(),id=call(resource,'get_instance_id'),same=call(G,'instance_from_id',id)===resource;
    observations.resourceInstanceId={value:String(id),type:typeof id,identityRoundtrip:same};return same;
  });
  if(observations.newModuleClasses.FastNoiseLite.registered)check('fullModuleNoise',()=>{
    const noise=new (type('FastNoiseLite'))();call(noise,'set','seed',9);const value=call(noise,'get_noise_2d',12.5,14.25);return Number.isFinite(value)&&call(noise,'get','seed')===9&&value===call(noise,'get_noise_2d',12.5,14.25);
  });
  if(instrumented){
    check('genericBuiltinMetadata',()=>{
      const vector=ir.builtins.find(v=>v.name==='Vector2');return !!vector?.constructors?.some(v=>v.args.length===2)&&!!vector.methods.some(v=>v.name==='length')&&!!vector.properties.some(v=>v.name==='x')&&!!vector.operators.length;
    });
    check('genericUtilityMetadata',()=>ir.utilities.some(v=>v.name==='is_instance_valid')&&ir.global_constants.some(v=>v.name==='OK'));
  }
  const raw=JSON.stringify(ir);attach('api-ir.json',raw);
  const report={probe:'api',status:Object.values(checks).every(Boolean)?'passed':'executed-with-gaps',instrumented,naming:ir.bindingNaming,checks,observations,failures,irBytes:raw.length};
  attach('api-details.json',JSON.stringify(report));
  console.log('P0_API_REPORT '+JSON.stringify(report));
  // A zero code means evidence collection completed. Consult checks/status for gate outcomes.
  host.__p0ApiExitCode=0;
  return report;
};
exports.default=class ApiProbe extends type('Node'){
  _ready(){this.__p0ApiFrames=0;try{exports.runApiProbe(this);}catch(error){console.error('P0_API_FAILED '+String(error)+' '+error?.stack);this.__p0ApiExitCode=1;}}
  _process(){if(++this.__p0ApiFrames>=3&&this.__p0ApiExitCode!==undefined)call(call(this,'get_tree'),'quit',this.__p0ApiExitCode);}
};

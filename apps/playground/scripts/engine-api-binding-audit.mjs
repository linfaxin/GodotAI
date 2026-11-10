/** Executed inside GodotJS against the same target as the captured API. Pure
 * function so native/Web PCK fixtures can embed its source without a bundler. */
export function auditEngineBinding(G,J) {
 const names=J.internal.names,member=name=>names.get_member(name),type=name=>G[names.get_class(name)],checks={},details={};
 const check=(name,fn)=>{try{checks[name]=fn()===true;}catch(error){checks[name]=false;details[name]=String(error);}};
 check('constructorInheritance',()=>{const value=new(type('Node2D'))();const valid=value instanceof type('Node');value.free();return valid;});
 check('methodPropertyOperator',()=>{const V=type('Vector2'),left=new V(1,2),right=new V(3,4),sum=V.ADD(left,right);return sum.x===4&&sum.y===6;});
 check('indexed',()=>{const value=new(type('Vector2'))(1,2);value[member('set_indexed')](0,7);return value[member('get_indexed')](0)===7&&value.x===7;});
 check('keyed',()=>{const value=new(type('Dictionary'))();value[member('set_keyed')]('item',3);return value[member('get_keyed')]('item')===3;});
 check('stringUtility',()=>type('String').length_('abc')===3);
 check('constantName',()=>type('Vector2').ZERO.x===0&&type('Vector2').ZERO.y===0);
 check('bufferHelper',()=>{const value=new(type('PackedByteArray'))();value[member('push_back')](4);const result=value[member('to_array_buffer')]();return result instanceof ArrayBuffer&&result.byteLength===1;});
 check('arrayHelper',()=>type('Array').create([1,2]).proxy()[1]===2);
 check('dictionaryHelper',()=>type('Dictionary').create({item:3}).proxy().item===3);
 check('callableHelper',()=>type('Callable').create(()=>7).call()===7);
 check('signalHelper',()=>typeof type('Signal').prototype[member('as_promise')]==='function');
 check('readonlyProperty',()=>{const descriptor=Object.getOwnPropertyDescriptor(type('Timer').prototype,member('time_left'));return typeof descriptor?.get==='function'&&descriptor.set===undefined;});
 check('methodOnlyProperty',()=>{const value=new(type('Node'))();value[member('set_name')]('original');value.name='expando';const valid=value[member('get_name')]==null?false:value[member('get_name')]()==='original';value.free();return valid;});
 const api=J.internal.get_engine_api(),missing=[],counts={classes:0,methods:0,properties:0,signals:0,virtualDeclarations:0,builtins:0,builtinMethods:0,builtinExtras:0,operators:0};
 for(const cls of api.classes){
  try{
   const value=G[cls.publicName],prototype=typeof value==='function'?value.prototype:Object.getPrototypeOf(value),constructor=typeof value==='function'?value:prototype?.constructor;
   if(!prototype){missing.push({kind:'class',class:cls.nativeName});continue;}counts.classes++;
   for(const method of cls.methods){
    if(method.binding==='accessor')continue;
    if(method.flags&8){counts.virtualDeclarations++;continue;}
    const target=method.flags&32?(typeof value?.[method.publicName]==='function'?value:constructor):prototype;
    if(typeof target?.[method.publicName]!=='function')missing.push({kind:'method',class:cls.nativeName,native:method.nativeName,public:method.publicName,constructorType:typeof constructor,constructorName:constructor?.name});
    else counts.methods++;
   }
   for(const property of cls.properties){
    if(property.binding!=='property')continue;
    const descriptor=Object.getOwnPropertyDescriptor(prototype,property.publicName);
    if(!descriptor?.get&&!descriptor?.set)missing.push({kind:'property',class:cls.nativeName,native:property.nativeName,public:property.publicName});
    else counts.properties++;
   }
   for(const signal of cls.signals){let current=prototype,descriptor;while(current&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(current,signal.publicName);current=Object.getPrototypeOf(current);}if(!descriptor?.get)missing.push({kind:'signal',class:cls.nativeName,native:signal.nativeName,public:signal.publicName});else counts.signals++;}
  }catch(error){missing.push({kind:'class',class:cls.nativeName,error:String(error)});}
 }
 for(const builtin of api.builtins){
  if(!builtin.bindingKind||builtin.bindingKind==='unbound')continue;
  try{
   const value=G[builtin.publicName];if(typeof value!=='function'){missing.push({kind:'builtin',class:builtin.nativeName});continue;}counts.builtins++;
   for(const method of builtin.methods){const target=builtin.bindingKind==='utility'||method.flags&32?value:value.prototype;if(typeof target?.[method.publicName]!=='function')missing.push({kind:'builtinMethod',class:builtin.nativeName,native:method.nativeName,public:method.publicName});else counts.builtinMethods++;}
   for(const [kind,name]of Object.entries(builtin.bindingExtras??{})){if(kind==='builtinType'){if(value[name]!==builtin.type)missing.push({kind:'builtinType',class:builtin.nativeName});}else if(typeof value.prototype?.[name]!=='function')missing.push({kind:'builtinExtra',class:builtin.nativeName,public:name});else counts.builtinExtras++;}
   for(const operation of builtin.bindingOperators??[]){if(typeof value[operation.publicName]!=='function')missing.push({kind:'operator',class:builtin.nativeName,public:operation.publicName});else counts.operators++;}
  }catch(error){missing.push({kind:'builtin',class:builtin.nativeName,error:String(error)});}
 }
 checks.bindingMatrix=missing.length===0;details.bindingMatrix={counts,missing};
 return{status:Object.values(checks).every(Boolean)?'passed':'failed',checks,details};
}

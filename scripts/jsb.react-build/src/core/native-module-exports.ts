/** JS module metadata must never become a native ClassDB lookup. */
function nativeNamespace(load:(name:string)=>any):Record<string,unknown> {
 const raw=load('godot');let names:Set<string>|undefined;
 const exports=()=>{
  if(names)return names;
  const api=load('godot-jsb').internal.get_engine_api();
  names=new Set<string>(Object.keys(raw));
  for(const item of api.classes)if(item.enabled!==false&&item.exposed!==false)names.add(item.publicName);
  for(const item of api.builtins)if(item.bindingKind!=='unbound')names.add(item.publicName);
  for(const item of [...api.singletons,...api.utilities,...api.globalConstants])names.add(item.publicName);
  for(const item of api.globalConstants)if(item.enumPublicName)names.add(item.enumPublicName.split('.')[0]);
  names.add('GLOBAL_GET');names.add('EDITOR_GET');
  names.delete('default');names.delete('__esModule');names.delete('then');return names;
 };
 const namespace:Record<string,unknown>=new Proxy(Object.create(null),{
  get(_target,key){if(key==='then')return undefined;if(key==='__esModule')return true;if(key==='default')return namespace;if(key===Symbol.toStringTag)return 'Module';return raw[key];},
  ownKeys:()=>[...exports()].sort(),
  has:(_target,key)=>typeof key==='string'&&(key==='default'||key==='__esModule'||exports().has(key)),
  getOwnPropertyDescriptor(_target,key){
   if(key==='default'||key==='__esModule')return {configurable:true,enumerable:false,value:key==='default'?namespace:true};
   if(typeof key==='string'&&exports().has(key))return {configurable:true,enumerable:true,get:()=>raw[key]};
   return undefined;
  },
  set:()=>false,defineProperty:()=>false,deleteProperty:()=>false,preventExtensions:()=>false,
 });
 return namespace;
}
export function nativeModuleSource():string {
 return `module.exports = (${nativeNamespace.toString()})(require);\n`;
}

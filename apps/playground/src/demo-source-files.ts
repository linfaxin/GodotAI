import {readPckIndex} from '@godot-js/engine/pck-index';
import {mergeResourceUidCaches} from '@godot-js/project-tools/resource-uids';

/** A release resource pack is admitted once, then joined to each immutable build. */
export class DemoSourceComposer {
 private current:{identity:string;files:Readonly<Record<string,Uint8Array>>}|undefined;
 compose(source:Readonly<Record<string,string|number[]|Uint8Array>>,demo:{resources:Uint8Array;demoDescriptorHash:string},inputSource:string):Record<string,string|number[]|Uint8Array>{
 if(this.current?.identity!==demo.demoDescriptorHash){
  const files:Record<string,Uint8Array>=Object.create(null);
  for(const entry of readPckIndex(demo.resources).entries){
   if(!/^res:\/\/(?:assets\/|shaders\/|\.godot\/(?:imported|exported)\/)/.test(entry.path)&&!['res://.godot/uid_cache.bin','res://.playground/demo-manifest.json'].includes(entry.path))throw Error('E_DEMO_RESOURCE_PATH: '+entry.path);
   files['/'+entry.path.slice(6)]=demo.resources.slice(entry.offset,entry.offset+entry.bytes);
  }
  this.current={identity:demo.demoDescriptorHash,files:Object.freeze(files)};
 }
 const result:Record<string,string|number[]|Uint8Array>={...source},encoder=new TextEncoder();
 const bytes=(value:string|number[]|Uint8Array)=>typeof value==='string'?encoder.encode(value):Uint8Array.from(value);
 for(const [path,value]of Object.entries(this.current.files)){
  const aliases=[path,'res://'+path.slice(1),path.slice(1)].filter(name=>Object.hasOwn(result,name));
  if(aliases.length>1)throw Error('E_DEMO_RESOURCE_COLLISION: '+path);
  if(path==='/.godot/uid_cache.bin'&&aliases.length){const primary=bytes(result[aliases[0]]!);for(const alias of aliases)delete result[alias];result[path]=mergeResourceUidCaches([primary,value]);continue;}
  if(aliases.length)throw Error('E_DEMO_RESOURCE_COLLISION: '+path);
  result[path]=value;
 }
 if(Object.hasOwn(result,'/.playground/demo-input.ts'))throw Error('E_DEMO_RESOURCE_COLLISION: demo-input.ts');
 result['/.playground/demo-input.ts']=inputSource;return result;
}
}

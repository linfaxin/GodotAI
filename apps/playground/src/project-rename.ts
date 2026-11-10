import {remapResourceUidCachePaths} from '@godot-js/react-build/resource-uids';
import {rewriteResourceReferences} from './project-resource-references.ts';

type Files=Record<string,string|number[]>;
const textResource=/\.(?:tscn|tres|godot|cfg|import|remap|gd|gdshader|gdshaderinc)$/i;
const binaryResource=/(?:\.(?:scn|res)$|\/project\.binary$)/i;
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
/** Prepare all native reference edits before committing a file rename. */
export function renamedProjectFiles(files:Files,old:string,path:string,native:boolean):Files {
 const moves=new Map([[old,path]]);
 if(native){
  const binary=Object.keys(files).find(name=>binaryResource.test(name));
  if(binary)throw Error('项目包含二进制 Godot 资源，无法安全更新引用，请在 Godot 编辑器中重命名：'+binary);
  if(old.slice(old.lastIndexOf('.'))!==path.slice(path.lastIndexOf('.')))throw Error('原生项目重命名须保留文件扩展名');
  for(const suffix of ['.uid','.import','.remap'])if(Object.hasOwn(files,old+suffix))moves.set(old+suffix,path+suffix);
 }
 const names=new Set<string>();
 for(const source of Object.keys(files)){
  const target=moves.get(source)??source,key=target.toLowerCase();
  if(names.has(key))throw Error('文件或旁文件已存在：'+target);
  names.add(key);
 }
 const result:Files={};
 for(const [source,original]of Object.entries(files)){
  const target=moves.get(source)??source;
  let value=original;
  if(native&&textResource.test(source)){
   let text:string;
   try{text=typeof original==='string'?original:decoder.decode(Uint8Array.from(original));}
   catch{throw Error('原生资源文本无效，无法安全更新引用：'+source);}
   const rewritten=rewriteResourceReferences(text,source,target,moves,files);
   if(rewritten!==text)value=typeof original==='string'?rewritten:[...encoder.encode(rewritten)];
  }
  if(native&&source==='/.godot/uid_cache.bin'){
   if(!Array.isArray(original))throw Error('UID 缓存格式无效，无法安全重命名');
   const resourceMoves=new Map([...moves].map(([a,b])=>['res:/'+a,'res:/'+b]));
   value=[...remapResourceUidCachePaths(Uint8Array.from(original),resourceMoves)];
  }
  result[target]=value;
 }
 return result;
}

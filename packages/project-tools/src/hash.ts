import {ProjectToolError} from './errors.js';
import {hashOwnedBytes} from './owned-bytes.js';

/** Deterministic finite JSON; omitted/undefined fields must be resolved by the caller. */
export function canonicalJson(value:unknown):string {
 const visit=(item:unknown,seen:Set<object>):string=>{
  if(item===null||typeof item==='string'||typeof item==='boolean')return JSON.stringify(item);
  if(typeof item==='number'&&Number.isFinite(item))return JSON.stringify(item);
  if(typeof item!=='object'||!item)throw new ProjectToolError('E_CANONICAL_JSON','Only finite JSON values are supported');
  if(seen.has(item))throw new ProjectToolError('E_CANONICAL_JSON','Cyclic JSON is unsupported');
  if(!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))throw new ProjectToolError('E_CANONICAL_JSON','Only plain JSON objects are supported');
  seen.add(item);
  try {
   if(Array.isArray(item))return '['+Array.from(item,value=>visit(value,seen)).join(',')+']';
   return '{'+Object.keys(item).sort().map(key=>{
    const descriptor=Object.getOwnPropertyDescriptor(item,key)!;
    if(!('value' in descriptor))throw new ProjectToolError('E_CANONICAL_JSON','JSON accessors are unsupported');
    return JSON.stringify(key)+':'+visit(descriptor.value,seen);
   }).join(',')+'}';
  }finally{seen.delete(item);}
 };
 return visit(value,new Set());
}
export async function hashBytes(value:string|Uint8Array):Promise<string> {
 const bytes=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value);
 return hashOwnedBytes(bytes);
}
export function hashJson(value:unknown):Promise<string>{return hashBytes(canonicalJson(value));}

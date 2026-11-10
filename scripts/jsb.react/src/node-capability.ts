/** Private branding shared by value codecs and the renderer. Not a public SDK export. */
const handles=new WeakMap<object,()=>unknown>();
export function registerNodeCapability(handle:object,resolve:()=>unknown):void{handles.set(handle,resolve);}
export function encodeNodeCapability(value:unknown):unknown{const resolve=value&&typeof value==='object'?handles.get(value):undefined;if(!resolve)throw Error('E_NODE_CAPABILITY: expected a live managed node handle');return resolve();}

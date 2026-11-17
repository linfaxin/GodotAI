/** Canonical realm-local endpoint router. No React, NativePort or schema whitelist. */
import type {NativeRpcContext} from './native-interface-contracts';
type Dispatch=(profile:string,schemaHash:string,method:string,args:readonly unknown[],context?:NativeRpcContext)=>boolean;
const endpoints=new Map<string,{owner:object;dispatch:Dispatch}>();
export function nativeEndpointExists(identity:string):boolean{return endpoints.has(identity);}
export function nativeEndpointOwner(identity:string):object|undefined{return endpoints.get(identity)?.owner;}
export function registerNativeEndpoint(identity:string,owner:object,dispatch:Dispatch):()=>void {
 if(!identity||identity.length>1024||endpoints.has(identity))throw Error('E_NATIVE_INTERFACE: Invalid or repeated endpoint');
 endpoints.set(identity,{owner,dispatch});return()=>unregisterNativeEndpoint(identity,owner);
}
export function unregisterNativeEndpoint(identity:string,owner:object):void {if(endpoints.get(identity)?.owner===owner)endpoints.delete(identity);}
/** Generated native scripts and all adapters share this exact singleton. */
export function dispatchNativeInterface(identity:unknown,profile:string,schemaHash:string,method:string,args:readonly unknown[],context?:NativeRpcContext):boolean {
 if(typeof identity!=='string')return false;
 return endpoints.get(identity)?.dispatch(profile,schemaHash,method,args,context)??false;
}

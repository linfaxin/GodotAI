import * as React from 'react';
import {useRuntime, type NodeRef} from './runtime';
import {nativeInterfaceSchema, type NativeInterfaceToken, type NativeInterfaceHandlers, type SynchronousNativeHandlers} from './native-interface-contracts';
import {type NativeInterfaceRegistry} from './native-interface-legacy';
/** The host must already carry nativeInterface={token}; this Hook never changes its script. */
export function useNativeInterface<K extends string,H extends NativeInterfaceHandlers>(ref:NodeRef<K>, token:NativeInterfaceToken, handlers:H & SynchronousNativeHandlers<H>):Readonly<{send(method:string,args:readonly unknown[],options?:{peerId?:number}):Readonly<{localError:number}>}> {
  const root=useRuntime() as ReturnType<typeof useRuntime> & {nativeInterfaces:NativeInterfaceRegistry};
  nativeInterfaceSchema(token);
  React.useLayoutEffect(()=>root.nativeInterfaces.commitRef(ref as NodeRef,token,handlers));
  return React.useMemo(()=>Object.freeze({send:(method:string,args:readonly unknown[],options?:{peerId?:number})=>root.nativeInterfaces.send(ref.current,token,method,args,options?.peerId)}),[root,ref,token]);
}

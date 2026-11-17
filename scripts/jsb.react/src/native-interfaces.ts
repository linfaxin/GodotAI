/** Compatibility API for NativePort consumers. Engine users import /engine-native-interfaces. */
import {HOST_SCHEMA} from './schema';
import * as contracts from './native-interface-contracts';
export type {NativeCallback,NativeRpcCodec,NativeRpcSchema,NativeInterfaceSchema,NormalizedNativeInterfaceSchema,NativeInterfaceToken,NativeInterfaceHandlers,SynchronousNativeHandlers,NativeDTO,NativeRpcContext} from './native-interface-contracts';
export {nativeInterfaceSchema,normalizeNativeInterfaceProp,getNativeInterfaceToken,normalizeNativeInterfaceProps,snapshotNativeDTO,encodeNativeRpcArguments} from './native-interface-contracts';
export {NativeInterfaceRegistry,type NativeInterfaceRegistryOptions} from './native-interface-legacy';
export {dispatchNativeInterface} from './native-interface-dispatch';
export {useNativeInterface} from './native-interface-legacy-hook';
export function validateNativeInterfaceSchema(input:unknown):contracts.NormalizedNativeInterfaceSchema {
 const normalized=contracts.validateNativeInterfaceSchema(input);
 if(!Object.hasOwn(HOST_SCHEMA,normalized.nativeLeaf))contracts.nativeInterfaceFailure('nativeLeaf must be a certified host type');
 return normalized;
}
export function nativeInterfaceSchemaHash(input:unknown):string {validateNativeInterfaceSchema(input);return contracts.nativeInterfaceSchemaHash(input);}
export function defineNativeInterface(profile:string,schema:contracts.NativeInterfaceSchema):contracts.NativeInterfaceToken {validateNativeInterfaceSchema(schema);return contracts.defineNativeInterface(profile,schema);}

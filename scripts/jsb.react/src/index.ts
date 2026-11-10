// The default root renders directly into the native GodotJS engine.
// The explicit three-argument NativePort overload retains existing projects.
export * from "./legacy";
export {EngineNode, EngineRoot, createNativeComponent, useFrame} from "./engine";
export type {EngineNodeProps, AdoptedNodeProps, EngineRootOptions, EngineErrorInfo, EngineStats, NativeProperties, NativeEvents, NativeConstructor} from "./engine";
import {createRoot as nativeRoot} from "./engine";
import {createRoot as legacyRoot} from "./runtime";
export function createRoot(...args:Parameters<typeof nativeRoot>):ReturnType<typeof nativeRoot>;
export function createRoot(...args:Parameters<typeof legacyRoot>):ReturnType<typeof legacyRoot>;
export function createRoot(first:object,second?:unknown,third?:unknown):ReturnType<typeof nativeRoot>|ReturnType<typeof legacyRoot>{
 if(third!==undefined)return legacyRoot(first as Parameters<typeof legacyRoot>[0],second as Parameters<typeof legacyRoot>[1],third as Parameters<typeof legacyRoot>[2]);
 return nativeRoot(first,second as Parameters<typeof nativeRoot>[1]);
}

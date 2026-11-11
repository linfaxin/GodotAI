/** Shared runtime/declaration metadata; the CJS source is available before builds. */
declare const require:(name:string)=>any;
export interface EngineSdkModule {exportName:string;declaration:string;scope:'shared'|'engine'|'legacy'|'testing'}
const contract=require('../../engine-modules.cjs');
export const ENGINE_SDK_MODULES:Readonly<Record<string,Readonly<EngineSdkModule>>>=contract.ENGINE_SDK_MODULES;
export const engineModuleDeclaration:(specifier:string,runtime:'godot'|'react')=>string|undefined=contract.engineModuleDeclaration;

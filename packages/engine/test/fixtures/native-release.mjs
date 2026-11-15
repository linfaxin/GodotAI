import {createHash} from 'node:crypto';
import {canonicalIdentityJson,nativeEngineIdentityInputs,nativeExtensionIdentityInputs,nativeReleaseIdentityInputs,createEngineIdentity,createExtensionIdentity} from '../../dist/identities.js';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const releaseId=value=>digest(canonicalIdentityJson(nativeReleaseIdentityInputs(value)));
export function sealRelease(manifest){manifest.id=releaseId(manifest);if(manifest.verifiedRelease)manifest.verifiedRelease.releaseId=manifest.id;return manifest;}
/** Synthetic transport/identity fixture, never browser or native evidence. */
export async function nativeReleaseFixture({legacy=false}={}){
 const files=new Map(),payloads={};
 const asset=(path,source)=>{const bytes=Buffer.from(source);files.set(path,bytes);return payloads[path]={path,sha256:digest(bytes),bytes:bytes.length};};
 const engineTypes={'/godot/index.d.ts':'export class Node {}'},types={...engineTypes,'/engine-sdk/engine.d.ts':'export function createRoot():void;'};
 const engine={javascript:asset('engine/game.js','/* synthetic engine */'),wasm:asset('engine/game.wasm',Buffer.from([0,97,115,109,1,0,0,0])),worklets:[]};
 const declaration=asset('api/godot.d.ts',engineTypes['/godot/index.d.ts']);
 const profile={bindingVersion:'binding/1',namingVersion:'naming/1',codegenVersion:'codegen/1',actualAPIHash:digest('synthetic API'),declarationsHash:digest(canonicalIdentityJson(engineTypes)),declarations:{'/godot/index.d.ts':declaration},typeSnapshot:asset('types.json',JSON.stringify(types))};
 const api={...profile,ir:asset('api/ir.json','{}'),namingProfiles:{snake:profile}};
 const sdk={...(legacy?{}:{identityVersion:2}),version:'1.0.0',typesHash:digest(canonicalIdentityJson({'/engine-sdk/engine.d.ts':types['/engine-sdk/engine.d.ts']})),vendor:asset('.playground/vendor.js','exports.engineReact={};'),vendors:{development:asset('.playground/vendor.development.js','exports.engineReact={development:true};')},moduleExports:{'@godot-js/react':'engineReact'},moduleContract:{'@godot-js/react':{exportName:'engineReact',declaration:'/engine-sdk/engine.d.ts',scope:'engine'}},runtimeModules:{'@godot-js/react':asset('.playground/react.js','module.exports=require("res://.playground/vendor.js").engineReact;')}};
 sdk.vendors.production=sdk.vendor;
 const execution={schemaVersion:1,executionModel:'window',wasmThreads:false,proxyToPthread:false,requiresCrossOriginIsolation:false,hostProtocolVersion:1};
 const manifest={schemaVersion:2,runtimeProfile:'engine-2d-v1',profile:'engine-2d-v1',...(legacy?{}:{artifactReceiptVersion:2}),engine,execution,modules:['GodotJS'],api,sdk,payloads,verifiedRelease:{engineJs:{url:engine.javascript.path,sha256:engine.javascript.sha256},engineWasm:{url:engine.wasm.path,sha256:engine.wasm.sha256}}};
 if(!legacy){manifest.engineId=await createEngineIdentity(nativeEngineIdentityInputs(manifest));manifest.extensionId=await createExtensionIdentity(nativeExtensionIdentityInputs(manifest));}
 sealRelease(manifest);return {manifest,files,types,engineTypes,asset};
}

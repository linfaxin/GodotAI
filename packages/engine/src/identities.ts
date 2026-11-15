/** Pure browser identity functions. Final artifact identity is external to its
 * own PCK, while the input-only buildKey may be embedded in that PCK. */
export function canonicalIdentityJson(value:unknown):string{
  const visit=(item:unknown):unknown=>{
    if(item===null||typeof item==='string'||typeof item==='boolean')return item;
    if(typeof item==='number'&&Number.isFinite(item))return item;
    if(Array.isArray(item))return item.map(visit);
    if(item&&Object.getPrototypeOf(item)===Object.prototype)return Object.fromEntries(Object.keys(item).sort().map(key=>[key,visit((item as Record<string,unknown>)[key])]));
    throw Error('E_IDENTITY_JSON: Expected finite JSON data');
  };
  return JSON.stringify(visit(value));
}
async function identity(kind:string,inputs:unknown):Promise<string>{
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalIdentityJson({kind,inputs})));
  return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
}
function rejectKeys(inputs:unknown,keys:readonly string[]):asserts inputs is Record<string,unknown>{
  if(!inputs||typeof inputs!=='object'||Array.isArray(inputs))throw Error('E_IDENTITY_INPUT: Expected object');
  for(const key of keys)if(key in inputs)throw Error('E_IDENTITY_SELF_REFERENCE: '+key);
}
export function createEngineIdentity(inputs:unknown):Promise<string>{rejectKeys(inputs,['engineId','id','url','releaseRoot','timestamp','createdAt','react','extensionId']);return identity('godotjs-engine-v1',inputs);}
export function createExtensionIdentity(inputs:unknown):Promise<string>{rejectKeys(inputs,['extensionId','id','url','timestamp','createdAt']);return identity('godotjs-extension-v1',inputs);}
export function createBuildKey(inputs:unknown):Promise<string>{rejectKeys(inputs,['buildKey','artifactId','packSha256','outputHashes','revision','runId']);return identity('godotjs-build-key-v1',inputs);}
export function createArtifactIdentity(inputs:unknown):Promise<string>{
  rejectKeys(inputs,['artifactId','id','runId','revision']);
  if(!/^[a-f0-9]{64}$/.test(String(inputs.buildKey??''))||!/^[a-f0-9]{64}$/.test(String(inputs.packSha256??'')))throw Error('E_IDENTITY_ARTIFACT: Expected build key and final pack hash');
  return identity('godotjs-artifact-v1',inputs);
}
export interface NativeEngineIdentitySource {
  execution?:unknown;
  engine:{javascript:unknown;wasm:unknown;worklets?:readonly unknown[];host?:unknown;execution?:unknown};
  modules:unknown;
  api:{bindingVersion?:unknown;namingVersion?:unknown;codegenVersion?:unknown;namingProfiles:Record<string,{actualAPIHash:unknown;declarationsHash:unknown}>};
}
/** Match the native descriptor without coupling its identity to SDK types,
 * React, deployment roots, the final manifest ID or its own HTML integrity. */
export function nativeEngineIdentityInputs(manifest:NativeEngineIdentitySource):unknown {
  const execution=manifest.execution??manifest.engine?.execution,api=manifest.api;
  if(!execution||!api?.namingProfiles||!manifest.engine)throw Error('E_IDENTITY_MANIFEST: Missing native identity inputs');
  const workers=(execution as {workerAssets?:readonly unknown[]}).workerAssets??[];
  return JSON.parse(JSON.stringify({assets:[manifest.engine.javascript,manifest.engine.wasm,...manifest.engine.worklets??[],...workers,...(manifest.engine.host?[manifest.engine.host]:[])],execution,modules:manifest.modules,api:{bindingVersion:api.bindingVersion,namingVersion:api.namingVersion,codegenVersion:api.codegenVersion,namingProfiles:Object.fromEntries(Object.entries(api.namingProfiles).map(([name,value])=>[name,{actualAPIHash:value.actualAPIHash,declarationsHash:value.declarationsHash}]))}}));
}
export async function assertNativeEngineIdentity(manifest:NativeEngineIdentitySource&{engineId:string}):Promise<void>{
  if(await createEngineIdentity(nativeEngineIdentityInputs(manifest))!==manifest.engineId)throw Error('E_IDENTITY_MANIFEST: Native engine identity differs from sealed content');
}
const digestPattern=/^[a-f0-9]{64}$/;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
async function hashJson(value:unknown):Promise<string>{
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalIdentityJson(value)));
  return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
}
function assetPath(value:unknown):value is string{return typeof value==='string'&&!!value&&!value.startsWith('/')&&!/[:\\\x00-\x1f\x7f]/.test(value)&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..');}
function asset(value:unknown):asserts value is Record<string,unknown>&{path:string;sha256:string;bytes:number}{
  if(!object(value)||!assetPath(value.path)||typeof value.sha256!=='string'||!digestPattern.test(value.sha256)||!Number.isSafeInteger(value.bytes)||Number(value.bytes)<0)throw Error('E_IDENTITY_ASSET: Invalid release asset');
}
export function nativeExtensionIdentityInputs(value:unknown):Record<string,unknown>{
  if(!object(value)||!object(value.sdk)||!object(value.api))throw Error('E_IDENTITY_EXTENSION: Missing SDK identity inputs');
  const sdk=value.sdk,vendors=sdk.vendors;
  if(!object(sdk.vendor)||!object(vendors)||!object(vendors.development))throw Error('E_IDENTITY_EXTENSION: Missing SDK vendor inputs');
  if(sdk.identityVersion!==undefined&&sdk.identityVersion!==2)throw Error('E_IDENTITY_EXTENSION: Unsupported SDK identity version');
  const runtimeModules=object(sdk.runtimeModules)?sdk.runtimeModules:{};
  let modern:Record<string,unknown>={};
  if(sdk.identityVersion===2){
    if(typeof sdk.typesHash!=='string'||!digestPattern.test(sdk.typesHash)||typeof sdk.version!=='string'||!sdk.version||typeof value.api.bindingVersion!=='string'||!value.api.bindingVersion)throw Error('E_IDENTITY_EXTENSION: Missing SDK types/version identity');
    if(!object(sdk.moduleExports)||!Object.keys(sdk.moduleExports).length||!object(sdk.moduleContract)||!Object.keys(runtimeModules).length)throw Error('E_IDENTITY_EXTENSION: Missing SDK module closure');
    if(!object(vendors.production)||Object.keys(vendors).some(name=>!['production','development'].includes(name)))throw Error('E_IDENTITY_EXTENSION: Invalid SDK modes');
    for(const key of ['path','sha256','bytes','encoding','decodedSha256','decodedBytes'])if(sdk.vendor[key]!==vendors.production[key])throw Error('E_IDENTITY_EXTENSION: Production vendor differs from primary SDK');
    const names=Object.keys(sdk.moduleExports);
    if(Object.keys(runtimeModules).length!==names.length||names.some(name=>!Object.hasOwn(runtimeModules,name)))throw Error('E_IDENTITY_EXTENSION: SDK runtime module set differs from exports');
    const moduleContract:Record<string,unknown>={};
    for(const name of names){
      const exportName=sdk.moduleExports[name],contract=sdk.moduleContract[name];
      if(typeof exportName!=='string'||!exportName||!object(contract)||contract.exportName!==exportName||typeof contract.declaration!=='string'||!contract.declaration.startsWith('/')||contract.declaration.split('/').includes('..'))throw Error('E_IDENTITY_EXTENSION: Invalid SDK module contract: '+name);
      moduleContract[name]=contract;asset(runtimeModules[name]);
    }
    modern={identityVersion:2,moduleContract,runtimeModules:Object.fromEntries(Object.entries(runtimeModules).map(([name,value])=>{asset(value);return[name,value.sha256];}))};
  }
  return {vendor:sdk.vendor.sha256,developmentVendor:vendors.development.sha256,sdkVersion:sdk.version,bindingVersion:value.api.bindingVersion,modules:sdk.moduleExports,...(sdk.typesHash!==undefined?{typesHash:sdk.typesHash}:{}),...modern};
}
/** Native schema 2 always seals its complete descriptor, including legacy
 * releases predating engineId/extensionId. Only the descriptor's own IDs are
 * excluded; SDK/type/payload metadata cannot retain an old release identity. */
export function nativeReleaseIdentityInputs(value:unknown):Record<string,unknown>{
  if(!object(value))throw Error('E_IDENTITY_RELEASE: Expected native descriptor');
  const inputs=JSON.parse(JSON.stringify(value)) as Record<string,unknown>;delete inputs.id;
  if(object(inputs.verifiedRelease))delete inputs.verifiedRelease.releaseId;
  return inputs;
}
export async function assertNativeReleaseIdentity(value:unknown):Promise<void>{
  if(!object(value)||value.schemaVersion!==2||typeof value.id!=='string'||!digestPattern.test(value.id))throw Error('E_IDENTITY_RELEASE: Invalid native descriptor');
  if(value.artifactReceiptVersion!==undefined&&value.artifactReceiptVersion!==2)throw Error('E_IDENTITY_RELEASE: Unsupported artifact receipt version');
  if(await hashJson(nativeReleaseIdentityInputs(value))!==value.id)throw Error('E_IDENTITY_RELEASE: Native descriptor content differs from its release ID');
  const modern=value.artifactReceiptVersion===2||(object(value.sdk)&&value.sdk.identityVersion!==undefined);
  if(modern||value.engineId!==undefined||value.extensionId!==undefined){
    if(typeof value.engineId!=='string'||!digestPattern.test(value.engineId)||typeof value.extensionId!=='string'||!digestPattern.test(value.extensionId))throw Error('E_IDENTITY_MANIFEST: Incomplete engine/extension identity pair');
    await assertNativeEngineIdentity(value as unknown as NativeEngineIdentitySource&{engineId:string});
    if(await createExtensionIdentity(nativeExtensionIdentityInputs(value))!==value.extensionId)throw Error('E_IDENTITY_EXTENSION: SDK content differs from its extension ID');
  }
  if(!object(value.payloads)||!object(value.engine)||!object(value.sdk)||!object(value.api))throw Error('E_IDENTITY_ASSET: Missing native payload closure');
  if(value.artifactReceiptVersion===2&&value.sdk.identityVersion!==2)throw Error('E_IDENTITY_EXTENSION: Modern releases require SDK identity v2');
  const payloads=value.payloads;
  for(const [name,item]of Object.entries(payloads)){asset(item);if(name!==item.path)throw Error('E_IDENTITY_ASSET: Payload key differs from asset path');}
  asset(value.engine.javascript);asset(value.engine.wasm);asset(value.sdk.vendor);asset(value.api.typeSnapshot);
  for(const field of ['host'])if(value.engine[field]!==undefined)asset(value.engine[field]);
  for(const field of ['worklets','workerAssets'])if(value.engine[field]!==undefined){if(!Array.isArray(value.engine[field]))throw Error('E_IDENTITY_ASSET: Invalid engine asset list');for(const item of value.engine[field])asset(item);}
  if(value.sdk.vendors!==undefined){if(!object(value.sdk.vendors))throw Error('E_IDENTITY_ASSET: Invalid SDK vendors');for(const item of Object.values(value.sdk.vendors))asset(item);}
  if(!object(value.sdk.runtimeModules))throw Error('E_IDENTITY_ASSET: Missing SDK runtime assets');
  for(const item of Object.values(value.sdk.runtimeModules))asset(item);
  if(value.api.ir!==undefined)asset(value.api.ir);
  const profileAssets=(profile:Record<string,unknown>)=>{
    asset(profile.typeSnapshot);
    for(const key of ['ir','capture','coverage','strictTypechecks','declarationsSnapshot'])if(profile[key]!==undefined)asset(profile[key]);
    if(profile.declarations!==undefined){if(!object(profile.declarations))throw Error('E_IDENTITY_ASSET: Invalid native declarations');for(const item of Object.values(profile.declarations))asset(item);}
  };
  profileAssets(value.api);
  if(value.api.namingProfiles!==undefined){if(!object(value.api.namingProfiles))throw Error('E_IDENTITY_ASSET: Invalid naming profiles');for(const profile of Object.values(value.api.namingProfiles)){if(!object(profile))throw Error('E_IDENTITY_ASSET: Invalid naming profile');profileAssets(profile);}}
  const visit=(item:unknown):void=>{
    if(Array.isArray(item)){for(const child of item)visit(child);return;}
    if(!object(item))return;
    if('path'in item||'sha256'in item||'bytes'in item){
      asset(item);const sealed=payloads[item.path];asset(sealed);
      for(const key of ['path','sha256','bytes','encoding','decodedSha256','decodedBytes','maxDecodedBytes'])if(item[key]!==sealed[key])throw Error('E_IDENTITY_ASSET: Reference is outside sealed payloads: '+item.path);
      return;
    }
    for(const child of Object.values(item))visit(child);
  };
  visit(value.engine);visit(value.api);visit(value.sdk);
  if(object(value.execution))visit(value.execution.workerAssets);
  if(object(value.verifiedRelease)){
    const verified=value.verifiedRelease;
    if(verified.releaseId!==value.id)throw Error('E_IDENTITY_RELEASE: Verified descriptor has a different release ID');
    const match=(reference:unknown,source:unknown)=>{
      asset(source);if(!object(reference)||reference.url!==source.path)throw Error('E_IDENTITY_ASSET: Verified engine differs from native descriptor');
      for(const key of ['sha256','encoding','decodedSha256','decodedBytes'])if(reference[key]!==source[key])throw Error('E_IDENTITY_ASSET: Verified asset differs from native descriptor');
      if(reference.bytes!==undefined&&reference.bytes!==source.bytes)throw Error('E_IDENTITY_ASSET: Verified asset length differs');
    };
    match(verified.engineJs,value.engine.javascript);match(verified.engineWasm,value.engine.wasm);
    for(const [key,sources]of [['worklets',value.engine.worklets??[]],['workerAssets',object(value.execution)?value.execution.workerAssets??[]:value.engine.workerAssets??[]]] as const){
      if(!Array.isArray(sources))throw Error('E_IDENTITY_ASSET: Invalid source asset list');
      const references=verified[key]??[];
      if(!Array.isArray(references)||references.length!==sources.length)throw Error('E_IDENTITY_ASSET: Verified asset list differs');
      for(const source of sources){asset(source);const reference=references.find(item=>object(item)&&item.url===source.path);match(reference,source);}
    }
    if(verified.execution!==undefined&&canonicalIdentityJson(verified.execution)!==canonicalIdentityJson(value.execution??value.engine.execution))throw Error('E_IDENTITY_ASSET: Verified execution differs');
  }
}
/** Check the type snapshot's actual contents after its transport hash has been
 * verified. Engine declarations and optional SDK declarations have separate IDs. */
export async function assertNativeTypeSnapshot(manifest:unknown,types:unknown,naming='snake'):Promise<void>{
  if(!object(manifest)||!object(manifest.api)||!object(types)||Object.values(types).some(value=>typeof value!=='string'))throw Error('E_IDENTITY_TYPES: Invalid declaration snapshot');
  const api=manifest.api,profiles=api.namingProfiles;
  const profile=object(profiles)&&object(profiles[naming])?profiles[naming] as Record<string,unknown>:api;
  const declarations=profile.declarations;
  if(object(declarations)&&typeof profile.declarationsHash==='string'){
    const actual=Object.fromEntries(Object.keys(declarations).map(name=>{if(typeof types[name]!=='string')throw Error('E_IDENTITY_TYPES: Missing native declaration '+name);return[name,types[name]];}));
    if(await hashJson(actual)!==profile.declarationsHash)throw Error('E_IDENTITY_TYPES: Native declarations differ from their engine identity');
  }
  if(object(manifest.sdk)&&manifest.sdk.typesHash!==undefined){
    const sdkTypes={...types};for(const name of Object.keys(object(declarations)?declarations:{}))delete sdkTypes[name];
    if(await hashJson(sdkTypes)!==manifest.sdk.typesHash)throw Error('E_IDENTITY_TYPES: SDK declarations differ from their extension identity');
    if(manifest.sdk.identityVersion===2&&object(manifest.sdk.moduleExports)&&object(manifest.sdk.moduleContract))for(const name of Object.keys(manifest.sdk.moduleExports)){
      const contract=manifest.sdk.moduleContract[name];if(!object(contract)||typeof contract.declaration!=='string'||typeof sdkTypes[contract.declaration]!=='string')throw Error('E_IDENTITY_TYPES: Missing SDK declaration for '+name);
    }
  }
}
/** A site may mirror one release at another origin, but cannot substitute the
 * native descriptor while retaining the site's sealed payload reference. */
export function assertSiteDescriptorIdentity(site:unknown,descriptor:{sha256:string;bytes:number},options:{required?:boolean}={}):void{
  const payloads=object(site)&&object(site.payloads)?site.payloads:undefined;
  const sealed=payloads?.['engine-release.json'];
  if(sealed===undefined&&!options.required)return;
  if(!object(sealed)||typeof sealed.sha256!=='string'||!digestPattern.test(sealed.sha256)||!Number.isSafeInteger(sealed.bytes)||Number(sealed.bytes)<0)throw Error('E_SITE_DESCRIPTOR_HASH: Missing native descriptor seal');
  if(sealed.path!==undefined&&sealed.path!=='engine-release.json')throw Error('E_SITE_DESCRIPTOR_HASH: Invalid native descriptor path');
  if(sealed.sha256!==descriptor.sha256||sealed.bytes!==descriptor.bytes)throw Error('E_SITE_DESCRIPTOR_HASH: Native descriptor differs from the site payload seal');
}
export interface ArtifactReceiptIdentity {schemaVersion:1|2;buildKey:string;sourceHash:string;packSha256:string;artifactId?:string}
/** New artifacts require schema 2. Legacy schema 1 or missing receipts are
 * admitted only through an explicit compatibility option, never by omission. */
export async function assertArtifactReceipt(value:unknown,options:{pack?:Uint8Array;buildKey?:string;artifactId?:string;allowLegacy?:boolean}={}):Promise<ArtifactReceiptIdentity|undefined>{
  if(value===undefined&&options.allowLegacy){if(options.artifactId!==undefined)throw Error('E_ARTIFACT_IDENTITY: Legacy artifacts cannot claim a verified artifact ID');return undefined;}
  if(!object(value)||(value.schemaVersion!==1&&value.schemaVersion!==2)||(value.schemaVersion!==2&&!options.allowLegacy))throw Error('E_ARTIFACT_RECEIPT: Expected schema 2 artifact receipt');
  for(const key of ['buildKey','sourceHash','packSha256'])if(typeof value[key]!=='string'||!digestPattern.test(value[key] as string))throw Error('E_ARTIFACT_RECEIPT: Invalid '+key);
  if(options.buildKey!==undefined&&value.buildKey!==options.buildKey)throw Error('E_ARTIFACT_BUILD_KEY');
  if(!Array.isArray(value.outputs))throw Error('E_ARTIFACT_RECEIPT: Missing output closure');
  const paths=new Set();
  for(const entry of value.outputs){
    if(!object(entry)||typeof entry.path!=='string'||!entry.path.startsWith('res://')||!assetPath(entry.path.slice(6))||paths.has(entry.path)||!['unchanged','generated','replaced','removed'].includes(String(entry.disposition)))throw Error('E_ARTIFACT_RECEIPT: Invalid output closure');
    paths.add(entry.path);
    if(entry.disposition==='removed'?entry.outputHash!==undefined:typeof entry.outputHash!=='string'||!digestPattern.test(entry.outputHash))throw Error('E_ARTIFACT_RECEIPT: Invalid output hash');
    if(entry.inputHash!==undefined&&(typeof entry.inputHash!=='string'||!digestPattern.test(entry.inputHash)))throw Error('E_ARTIFACT_RECEIPT: Invalid input hash');
  }
  if(value.schemaVersion===2){
    const {artifactId,...inputs}=value;
    if(typeof artifactId!=='string'||!digestPattern.test(artifactId)||await createArtifactIdentity(inputs)!==artifactId)throw Error('E_ARTIFACT_IDENTITY: Receipt differs from its artifact ID');
  }else if(value.artifactId!==undefined)throw Error('E_ARTIFACT_IDENTITY: Legacy receipts cannot claim a verified artifact ID');
  if(options.artifactId!==undefined&&value.artifactId!==options.artifactId)throw Error('E_ARTIFACT_IDENTITY: Outer artifact ID differs');
  if(options.pack){
    const digest=await crypto.subtle.digest('SHA-256',options.pack.slice().buffer);
    if(Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')!==value.packSha256)throw Error('E_ARTIFACT_PACK_HASH');
  }
  return value as unknown as ArtifactReceiptIdentity;
}
export interface RuntimeTargetIdentity {engineId:string;extensionId?:string}
/** Use at project/session boundaries after the engine descriptor itself has
 * been verified. An engine-only project has no required React extension. */
export function assertRuntimeTargetIdentity(actual:RuntimeTargetIdentity,expected:RuntimeTargetIdentity):void{
  for(const target of [actual,expected]){
    if(!target||!/^[a-f0-9]{64}$/.test(target.engineId)||target.extensionId!==undefined&&!/^[a-f0-9]{64}$/.test(target.extensionId))throw Error('E_RUNTIME_TARGET_IDENTITY: Invalid target');
  }
  if(actual.engineId!==expected.engineId)throw Error('E_RUNTIME_TARGET_ENGINE: Project targets a different engine');
  if(expected.extensionId!==undefined&&actual.extensionId!==expected.extensionId)throw Error('E_RUNTIME_TARGET_EXTENSION: Project targets a different extension');
}

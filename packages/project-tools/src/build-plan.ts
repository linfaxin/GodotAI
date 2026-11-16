import type {EngineProjectOptions,PreparedEngineProject} from './engine-project.js';
import {decodeProjectText,readProjectStringSetting} from './project-settings.js';
import {resourcePath} from './paths.js';
import {hashBytes,hashJson,canonicalJson} from './hash.js';
import {ProjectToolError} from './errors.js';
import type {PackOptions} from './pck.js';
import {requireFreshImports,assessImportReceipt,assessStoredImportReceipt,assessLegacyImportCaches,type LegacyImportObservation,type ImportAssessment,type ImportReceipt,type ImportInspection} from './import-receipts.js';
import {prepareResourceUidCache,resolveResourceUidFromCache} from './resource-uids.js';
import {type ResourceImportRequest,type ResourceConverterRegistry,type ResourceConversionResult} from './resource-converters.js';
import type {ImportTarget} from './import-receipts.js';
import {parseProjectLaunch} from './launch.js';
import {createArtifactIdentity} from '@godot-js/engine/identities';

export type ProjectLaunch={kind:'scene';source:'project'}|{kind:'scene';source:'override';path:string}|{kind:'script';module:string;export?:string};
export interface SourceFile {readonly path:string;readonly encoding:'utf8'|'binary';readonly bytes:readonly number[];readonly sha256:string}
export interface SourceSnapshot {readonly schemaVersion:1;readonly files:readonly SourceFile[];readonly sourceHash:string}
export interface BuildPlan {
 readonly schemaVersion:1;readonly snapshot:SourceSnapshot;readonly launch:ProjectLaunch;
 readonly compatibility?:{schemaVersion:1|2|3;runtime:'godot'|'react';entry?:string;entryExport?:string;mainScene?:string};
 readonly inputs:Readonly<Record<string,unknown>>;readonly buildKey:string;
}
export interface OutputEntry {path:string;disposition:'unchanged'|'generated'|'replaced'|'removed';reason:string;inputHash?:string;outputHash?:string}
export interface OutputOverlay {readonly entries:readonly OutputEntry[];readonly files:ReadonlyMap<string,Uint8Array>}
export interface PlannedProject {readonly plan:BuildPlan;readonly prepared:PreparedEngineProject;readonly overlay:OutputOverlay;readonly imports:readonly ImportAssessment[];readonly importReceipts:readonly ImportReceipt[]}
function immutableJson<T>(value:T):T {
 const copy=JSON.parse(canonicalJson(value));
 const freeze=(item:any):any=>{if(item&&typeof item==='object'){for(const value of Object.values(item))freeze(value);Object.freeze(item);}return item;};
 return freeze(copy);
}
export type SourceInput=Readonly<Record<string,string|readonly number[]|Uint8Array>>|ReadonlyMap<string,string|readonly number[]|Uint8Array>;
export async function createSourceSnapshot(input:SourceInput,limits:{maxFiles?:number;maxBytes?:number}={}):Promise<SourceSnapshot>{
 const rows=typeof (input as ReadonlyMap<string,unknown>)[Symbol.iterator]==='function'?[...(input as ReadonlyMap<string,string|readonly number[]|Uint8Array>)]:Object.entries(input);
 if(!rows.length||rows.length>(limits.maxFiles??10000))throw new ProjectToolError('E_PROJECT_BUDGET','Source file count exceeds budget');
 let size=0;const folded=new Set<string>();
 const files=await Promise.all(rows.map(async([name,value])=>{
  const path=resourcePath(name);if(folded.has(path.toLowerCase()))throw new ProjectToolError('E_PROJECT_PATH_COLLISION',`Source paths collide at ${path}`);folded.add(path.toLowerCase());
  if(typeof value!=='string'&&!(value instanceof Uint8Array)&&(!Array.isArray(value)||!value.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255)))throw new ProjectToolError('E_PROJECT_BYTES',`Invalid source bytes at ${path}`);
  const bytes=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value as ArrayLike<number>);
  size+=bytes.byteLength;if(size>(limits.maxBytes??64*1024*1024))throw new ProjectToolError('E_PROJECT_BUDGET','Source bytes exceed budget');
  return Object.freeze({path,encoding:typeof value==='string'?'utf8' as const:'binary' as const,bytes:Object.freeze([...bytes]),sha256:await hashBytes(bytes)});
 }));
 const identities=files.map(({path,encoding,sha256})=>({path,encoding,sha256})).sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
 return Object.freeze({schemaVersion:1 as const,files:Object.freeze(files),sourceHash:await hashJson(identities)});
}
export function snapshotFiles(snapshot:SourceSnapshot):Record<string,string|number[]>{
 return Object.fromEntries(snapshot.files.map(file=>[file.path,file.encoding==='utf8'?new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(file.bytes)):[...file.bytes]]));
}
export function resolveProjectLaunch(snapshot:SourceSnapshot,launch:ProjectLaunch):{launch:ProjectLaunch;mainScene?:string}{
 launch=parseProjectLaunch(launch);
 if(launch.kind==='script'){
  if(typeof launch.module!=='string')throw new ProjectToolError('E_PROJECT_LAUNCH','Script launch requires a module');
  const module=resourcePath(launch.module);
  if(!snapshot.files.some(file=>file.path===module&&file.encoding==='utf8'))throw new ProjectToolError('E_PROJECT_LAUNCH',`Script entry is missing: ${module}`);
  if(launch.export!==undefined&&(!launch.export||typeof launch.export!=='string'))throw new ProjectToolError('E_PROJECT_LAUNCH','Invalid script export');
  return {launch:{kind:'script',module,export:launch.export??'start'}};
 }
 if(!['project','override'].includes(launch.source))throw new ProjectToolError('E_PROJECT_LAUNCH','Scene launch requires project settings or override');
 let mainScene:string|undefined;
 if(launch.source==='override')mainScene=launch.path;
 else {
  const file=snapshot.files.find(file=>file.path==='res://project.godot');
  if(!file&&snapshot.files.some(file=>file.path==='res://project.binary'))return {launch:{kind:'scene',source:'project'}};
  const text=file&&decodeProjectText(Uint8Array.from(file.bytes));
  mainScene=text===undefined?undefined:readProjectStringSetting(text,'application','run/main_scene');
 }
 if(!mainScene)throw new ProjectToolError('E_PROJECT_LAUNCH','Scene launch has no main scene');
 if(!mainScene.startsWith('uid://'))mainScene=resourcePath(mainScene);
 const nativeFiles=new Map(snapshot.files.map(file=>[file.path,Uint8Array.from(file.bytes)]));
 const uid=prepareResourceUidCache(nativeFiles,mainScene);
 if(uid.diagnostics.some(value=>value.category==='error'))throw new ProjectToolError('E_PROJECT_LAUNCH',uid.diagnostics.map(value=>value.message).join('\n'));
 const actual=mainScene.startsWith('uid://')&&uid.cache?resolveResourceUidFromCache(mainScene,uid.cache):mainScene;
 if(!actual||!nativeFiles.has(actual)||! /\.(?:tscn|scn)$/i.test(actual))throw new ProjectToolError('E_PROJECT_LAUNCH',`Main scene is missing: ${mainScene}`);
 return {launch:launch.source==='project'?{kind:'scene',source:'project'}:{kind:'scene',source:'override',path:mainScene},mainScene};
}
export async function createBuildPlan(snapshot:SourceSnapshot,launch:ProjectLaunch,options:{inputs?:Readonly<Record<string,unknown>>;compatibility?:BuildPlan['compatibility']}={}):Promise<BuildPlan>{
 const resolved=resolveProjectLaunch(snapshot,launch),inputs=JSON.parse(canonicalJson(options.inputs??{}));
 const freeze=(value:any):any=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};freeze(inputs);
 const compatibility=options.compatibility?Object.freeze({...options.compatibility}):undefined;
 const identity={sourceHash:snapshot.sourceHash,launch:resolved.launch,inputs,...(compatibility?{compatibility}:{})};
 return Object.freeze({schemaVersion:1 as const,snapshot,launch:Object.freeze(resolved.launch),inputs:Object.freeze(inputs),...(compatibility?{compatibility}:{}),buildKey:await hashJson({kind:'godotjs-build-key-v1',inputs:identity})});
}
export async function adaptLegacyLaunch(document:unknown,options:{inputs?:Readonly<Record<string,unknown>>;limits?:{maxBytes?:number;maxFiles?:number}}={}):Promise<BuildPlan>{
 const envelope=document as any,data=envelope?.project??envelope,version=envelope?.schemaVersion??data?.schemaVersion??1;
 if(![1,2,3].includes(version)||!data?.files)throw new ProjectToolError('E_PROJECT_SCHEMA','Expected a schema 1/2/3 project');
 const runtime=version===1||data.runtime==='legacy-react'?'react':data.runtime;
 if(runtime!=='godot'&&runtime!=='react')throw new ProjectToolError('E_PROJECT_SCHEMA','Unknown legacy runtime');
 const snapshot=await createSourceSnapshot(data.files,options.limits),entry=data.entry??data.config?.entry;
 const explicitScene=data.mainSceneSource==='project'?undefined:data.mainScene??data.config?.mainScene;
 let launch:ProjectLaunch;
 if(runtime==='react')launch={kind:'script',module:entry,export:data.entryExport??data.config?.entryExport??'default'};
 else {
  const override=explicitScene;
  const project=snapshot.files.find(file=>file.path==='res://project.godot'),text=project&&decodeProjectText(Uint8Array.from(project.bytes));
  const scene=override??(text===undefined?undefined:readProjectStringSetting(text,'application','run/main_scene'));
  if(!scene&&!entry&&!snapshot.files.some(file=>file.path==='res://project.binary'))throw new ProjectToolError('E_ENGINE_MAIN_SCENE','Godot projects require application/run/main_scene in project.godot or an explicit mainScene option');
  launch=scene?(override?{kind:'scene',source:'override',path:scene}:{kind:'scene',source:'project'}):!project&&snapshot.files.some(file=>file.path==='res://project.binary')?{kind:'scene',source:'project'}:{kind:'script',module:entry,export:data.entryExport??'default'};
 }
 return createBuildPlan(snapshot,launch,{inputs:{...options.inputs,engineProfile:data.engineProfile??options.inputs?.engineProfile??'full-engine-v1'},compatibility:{schemaVersion:version,runtime,
  ...(entry?{entry}:{}),...(data.entryExport??data.config?.entryExport?{entryExport:data.entryExport??data.config?.entryExport}:{}),...(explicitScene?{mainScene:explicitScene}:{})}});
}
export async function createOutputOverlay(snapshot:SourceSnapshot,files:ReadonlyMap<string,Uint8Array>,reasons:ReadonlyMap<string,string>=new Map()):Promise<OutputOverlay>{
 const source=new Map(snapshot.files.map(file=>[file.path,file]));const entries:OutputEntry[]=[],copied=new Map<string,Uint8Array>();
 for(const [name,bytes]of files){const path=resourcePath(name),copy=new Uint8Array(bytes),outputHash=await hashBytes(copy),input=source.get(path);copied.set(path,copy);
  entries.push({path,disposition:!input?'generated':input.sha256===outputHash?'unchanged':'replaced',reason:reasons.get(path)??(!input?'Compiler-generated output':input.sha256===outputHash?'Original bytes preserved':path==='res://.godot/uid_cache.bin'?'Merged native UID index':path==='res://project.godot'?'Artifact-only launch settings':'Compiler-owned output replacement'),...(input?{inputHash:input.sha256}:{}),outputHash});source.delete(path);
 }
 for(const [path,input]of source)entries.push({path,disposition:'removed',reason:path==='res://project.binary'?'Text project settings are authoritative':'Removed from output by project preparation',inputHash:input.sha256});
 entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const view:ReadonlyMap<string,Uint8Array>=Object.freeze({
  get size(){return copied.size;},has:(key:string)=>copied.has(key),
  get:(key:string)=>{const bytes=copied.get(key);return bytes&&new Uint8Array(bytes);},
  keys:()=>copied.keys(),
  *values():Generator<Uint8Array,undefined,unknown>{for(const bytes of copied.values())yield new Uint8Array(bytes);return undefined;},
  *entries():Generator<[string,Uint8Array],undefined,unknown>{for(const [path,bytes]of copied)yield [path,new Uint8Array(bytes)] as [string,Uint8Array];return undefined;},
  *[Symbol.iterator]():Generator<[string,Uint8Array],undefined,unknown>{for(const [path,bytes]of copied)yield [path,new Uint8Array(bytes)] as [string,Uint8Array];return undefined;},
  forEach(callback:(value:Uint8Array,key:string,map:ReadonlyMap<string,Uint8Array>)=>void,thisArg?:unknown){for(const [path,bytes]of copied)callback.call(thisArg,new Uint8Array(bytes),path,view);},
 });
 return Object.freeze({entries:Object.freeze(entries.map(value=>Object.freeze(value))),files:view});
}
async function compilationInputs(options:Omit<EngineProjectOptions,'files'|'launch'|'entry'|'mainScene'>={}):Promise<Record<string,unknown>>{
 return {
  ...(options.vendor?{vendor:await hashBytes(options.vendor)}:{}),
  ...(options.runtimeModules?{runtimeModules:Object.fromEntries(await Promise.all(Object.entries(options.runtimeModules).map(async([name,bytes])=>[name,await hashBytes(bytes)])))}:{}),
  ...(options.generatedJs?{generatedJs:Object.fromEntries(await Promise.all(Object.entries(options.generatedJs).map(async([name,text])=>[name,await hashBytes(text)])))}:{}),
  ...(options.startup?{startup:options.startup}:{}),
  ...(options.maxBytes!==undefined?{maxBytes:options.maxBytes}:{}),...(options.maxFiles!==undefined?{maxFiles:options.maxFiles}:{}),
 };
}
function copyCompilerOptions(options:PrepareBuildPlanOptions['compilerOptions']):PrepareBuildPlanOptions['compilerOptions']{
 if(!options)return undefined;
 return {...options,...(options.vendor?{vendor:new Uint8Array(options.vendor)}:{}),
  ...(options.runtimeModules?{runtimeModules:Object.fromEntries(Object.entries(options.runtimeModules).map(([name,bytes])=>[name,new Uint8Array(bytes)]))}:{}),
  ...(options.generatedJs?{generatedJs:{...options.generatedJs}}:{}),
  ...(options.startup?{startup:{...options.startup,...(options.startup.requiredModules?{requiredModules:[...options.startup.requiredModules]}:{}),...(options.startup.vendorExports?{vendorExports:{...options.startup.vendorExports}}:{})}}:{}),
 };
}
export interface PrepareBuildPlanOptions {
 prepare?:(options:EngineProjectOptions)=>PreparedEngineProject;adapterIdentity?:string;compilerOptions?:Omit<EngineProjectOptions,'files'|'launch'|'entry'|'mainScene'>;
 imports?:readonly ImportAssessment[];storedImportReceipts?:readonly ImportReceipt[];importChecks?:readonly {receipt?:ImportReceipt;inspection:Omit<ImportInspection,'files'|'outputFiles'>}[];
 importCacheObservations?:readonly LegacyImportObservation[];
 resourceImports?:readonly ResourceImportRequest[];resourceConverters?:ResourceConverterRegistry;resourceTarget?:ImportTarget;
}
export async function prepareBuildPlan(plan:BuildPlan,options:PrepareBuildPlanOptions={}):Promise<PlannedProject>{
 const compilerSnapshot=copyCompilerOptions(options.compilerOptions);
 requireFreshImports(options.imports??[]);
 if(plan.compatibility?.runtime==='react'&&!options.prepare)throw new ProjectToolError('E_PROJECT_ADAPTER_REQUIRED','A legacy React startup adapter must be supplied explicitly');
 if(options.prepare&&!options.adapterIdentity)throw new ProjectToolError('E_PROJECT_ADAPTER_IDENTITY','An injected startup adapter requires an explicit identity');
 const sources=new Map(plan.snapshot.files.map(file=>[file.path,Uint8Array.from(file.bytes)]));
 let conversion:ResourceConversionResult|undefined;
 if(options.resourceImports?.length){
  if(!options.resourceConverters||!options.resourceTarget)throw new ProjectToolError('E_RESOURCE_CONVERTER','Explicit resource imports require an executable converter registry and target identity');
  conversion=await options.resourceConverters.run(options.resourceImports,sources,options.resourceTarget,options.storedImportReceipts);
 }
 const legacy=plan.compatibility;
 const compilationFiles=snapshotFiles(plan.snapshot);for(const [path,bytes]of conversion?.files??[])compilationFiles[path]=[...bytes];
 const compilerOptions:EngineProjectOptions={...copyCompilerOptions(compilerSnapshot),files:compilationFiles,runtime:legacy?.runtime??'engine',...(!legacy?{launch:plan.launch}:{
  ...(legacy.entry?{entry:legacy.entry}:{}),...(legacy.entryExport?{entryExport:legacy.entryExport}:{}),...(legacy.mainScene?{mainScene:legacy.mainScene}:{})})};
 const prepare=options.prepare??(await import('./engine-project.js')).prepareEngineProject;
 const prepared=prepare(compilerOptions);
 const assessments=await Promise.all((options.importChecks??[]).map(check=>assessImportReceipt(check.receipt,{...check.inspection,files:sources,outputFiles:prepared.files})));
 const checked=new Set((options.importChecks??[]).map(check=>resourcePath(check.inspection.resource)));
 for(const receipt of conversion?.receipts??[])checked.add(receipt.resource);
 const stored=await Promise.all((options.storedImportReceipts??[]).filter(receipt=>!checked.has(receipt.resource)).map(receipt=>assessStoredImportReceipt(receipt,sources,prepared.files)));
 const reported=new Set([...checked,...stored.map(item=>item.resource)]);
 const legacyImports=assessLegacyImportCaches(prepared.files,options.importCacheObservations).filter(item=>!reported.has(item.resource));
 requireFreshImports([...assessments,...stored,...legacyImports]);
 const effectivePlan=await createBuildPlan(plan.snapshot,plan.launch,{compatibility:plan.compatibility,inputs:{...plan.inputs,
  compilation:{tool:'godotjs-project-tools/3',typescript:(await import('typescript')).default.version,options:await compilationInputs(compilerSnapshot),...(options.adapterIdentity?{adapterIdentity:options.adapterIdentity}:{}),imports:(options.importChecks??[]).map(check=>({inspection:check.inspection,...(check.receipt?{receipt:check.receipt}:{})})),storedImportReceipts:options.storedImportReceipts??[],importCacheObservations:options.importCacheObservations??[],
   ...(conversion?{resourceImports:conversion.receipts.map(({resource,uid,converter,target,parameterHash,sources})=>({resource,...(uid?{uid}:{}),converter,target,parameterHash,sources}))}:{})}}});
 const imports=[...(options.imports??[]),...(conversion?.assessments??[]),...assessments,...stored,...legacyImports];
 const assessedResources=new Set(imports.map(item=>item.resource));
 const reportedPrepared={...prepared,diagnostics:[...prepared.diagnostics.filter(item=>item.code!=='W_ENGINE_IMPORT_UNVERIFIED'||!item.file||!assessedResources.has(item.file)),...imports.filter(item=>item.status==='unverified').map(item=>({file:item.resource,line:0,column:0,category:'warning' as const,code:'W_ENGINE_IMPORT_UNVERIFIED',message:`${item.resource}: cached import provenance is unverified; a source scan does not establish freshness.`}))]};
 return Object.freeze({plan:effectivePlan,prepared:reportedPrepared,overlay:await createOutputOverlay(plan.snapshot,prepared.files,conversion?.reasons),imports:immutableJson(imports),importReceipts:immutableJson(conversion?.receipts??[])});
}
export async function packPreparedProject(result:PlannedProject,options:PackOptions={}){
 const packOptions=JSON.parse(canonicalJson(options)) as PackOptions;
 const outputEntries=immutableJson(result.overlay.entries),importReceipts=immutableJson(result.importReceipts);
 const files=new Map([...result.overlay.files].map(([path,bytes])=>[path,new Uint8Array(bytes)]));
 const verified=await createOutputOverlay(result.plan.snapshot,files);
 const hashes=(entries:readonly OutputEntry[])=>entries.map(({reason,...entry})=>entry);
 if(canonicalJson(hashes(verified.entries))!==canonicalJson(hashes(outputEntries)))throw new ProjectToolError('E_PROJECT_OVERLAY','Output overlay differs from its recorded hashes; prepare the audited outputs again');
 const {packProject}=await import('./pck.js'),packed=packProject(files,packOptions),packSha256=await hashBytes(packed.pack);
 const packedPlan=await createBuildPlan(result.plan.snapshot,result.plan.launch,{compatibility:result.plan.compatibility,inputs:{...result.plan.inputs,pack:packOptions}});
 const receipt={schemaVersion:2 as const,buildKey:packedPlan.buildKey,sourceHash:result.plan.snapshot.sourceHash,packSha256,outputs:outputEntries,...(importReceipts.length?{imports:importReceipts}:{})};
 return {...result,plan:packedPlan,...packed,receipt:{...receipt,artifactId:await createArtifactIdentity(receipt)}};
}
export async function packBuildPlan(plan:BuildPlan,options:Parameters<typeof prepareBuildPlan>[1]&{pack?:PackOptions}={}){
 return packPreparedProject(await prepareBuildPlan(plan,options),options.pack);
}

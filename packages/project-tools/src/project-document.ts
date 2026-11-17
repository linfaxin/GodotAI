import {createSourceSnapshot,createBuildPlan,adaptLegacyLaunch,sourceFileText,type ProjectLaunch,type SourceInput,type BuildPlan,type SourceSnapshot} from './build-plan.js';
import {canonicalJson} from './hash.js';
import {ProjectToolError} from './errors.js';
import {parseProjectLaunch} from './launch.js';
import {parseImportReceipt,type ImportReceipt} from './import-receipts.js';
import {parseResourceImports,type ResourceImportRequest} from './resource-converters.js';

export interface EngineProjectDocument {
 [key:string]:unknown;
 schemaVersion:4;runtime:'engine';engineProfile:string;launch:ProjectLaunch;
 files:Record<string,string|number[]>;importReceipts?:ImportReceipt[];resourceImports?:ResourceImportRequest[];editor?:Record<string,unknown>;
}
export interface ReadProjectDocument {
 schemaVersion:1|2|3|4;plan:BuildPlan;originalDocument:unknown;originalText?:string;
 /** Only schema 4 has a new writer. Legacy reads never cause storage writes. */
 document?:EngineProjectDocument;
}
export {parseProjectLaunch} from './launch.js';

export async function createEngineProjectDocument(input:{files:SourceInput;launch:ProjectLaunch;engineProfile?:string;importReceipts?:readonly ImportReceipt[];resourceImports?:readonly ResourceImportRequest[];editor?:Record<string,unknown>},options:{sourceSnapshot?:SourceSnapshot}={}):Promise<EngineProjectDocument>{
 const launch=parseProjectLaunch(input.launch),snapshot=await createSourceSnapshot(input.files,{previous:options.sourceSnapshot});
 await createBuildPlan(snapshot,launch);
 const engineProfile=input.engineProfile??'full-engine-v1';
 if(!/^[a-z][a-z0-9._-]{0,127}$/.test(engineProfile))throw new ProjectToolError('E_PROJECT_PROFILE','Invalid engine profile');
 const files=Object.fromEntries(snapshot.files.map(file=>[file.path.startsWith('res://')?'/'+file.path.slice(6):file.path,file.encoding==='utf8'?sourceFileText(file):[...file.bytes]]));
 const importReceipts=input.importReceipts?.map(parseImportReceipt);
 if(importReceipts&&new Set(importReceipts.map(item=>item.resource)).size!==importReceipts.length)throw new ProjectToolError('E_IMPORT_RECEIPT','Duplicate resource receipts');
 return {schemaVersion:4,runtime:'engine',engineProfile,launch,files,...(importReceipts?{importReceipts}:{}),...(input.resourceImports?{resourceImports:parseResourceImports(input.resourceImports)}:{}),...(input.editor?{editor:JSON.parse(canonicalJson(input.editor))}:{})};
}
export async function readProjectDocument(input:unknown,options:{inputs?:Readonly<Record<string,unknown>>;sourceSnapshot?:SourceSnapshot}={}):Promise<ReadProjectDocument>{
 const originalText=typeof input==='string'?input:undefined;
 let value:unknown;try{value=originalText===undefined?structuredClone(input):JSON.parse(originalText);}catch{throw new ProjectToolError('E_PROJECT_SCHEMA','Invalid project JSON');}
 const envelope=value as any,data=envelope?.project??envelope,version=envelope?.schemaVersion??data?.schemaVersion??1;
 if(version===4){
  if(data.runtime!=='engine'||!data.files||Object.keys(data).some(key=>['entry','mainScene','mainSceneSource'].includes(key)))throw new ProjectToolError('E_PROJECT_SCHEMA','Schema 4 uses one engine runtime and an explicit launch');
  const normalized=await createEngineProjectDocument({files:data.files,launch:data.launch,engineProfile:data.engineProfile,importReceipts:data.importReceipts,resourceImports:data.resourceImports,editor:data.editor},options);
  const known=new Set(['schemaVersion','runtime','engineProfile','launch','files','importReceipts','resourceImports','editor']);
  const extra=JSON.parse(canonicalJson(Object.fromEntries(Object.entries(data).filter(([key])=>!known.has(key)))));
  const document:EngineProjectDocument={...extra,...normalized};
  const plan=await createBuildPlan(await createSourceSnapshot(document.files,{previous:options.sourceSnapshot}),document.launch,{inputs:{...options.inputs,engineProfile:document.engineProfile,...(document.importReceipts?{importReceipts:document.importReceipts}:{})}});
  return {schemaVersion:4,plan,document,originalDocument:value,...(originalText!==undefined?{originalText}:{})};
 }
 const snapshot=options.sourceSnapshot&&data?.files&&await createSourceSnapshot(data.files,{previous:options.sourceSnapshot});
 const plan=await adaptLegacyLaunch(value,{...options,snapshot});
 return {schemaVersion:version,plan,originalDocument:value,...(originalText!==undefined?{originalText}:{})};
}
/** Serialize only explicit new-schema documents; never upgrade a legacy read. */
export async function writeProjectDocument(input:EngineProjectDocument):Promise<string>{
 if(input?.schemaVersion!==4)throw new ProjectToolError('E_PROJECT_WRITE','Legacy documents must retain their original format; automatic migration is disabled');
 const read=await readProjectDocument(input);
 return JSON.stringify(read.document,null,2)+'\n';
}
export function exportOriginalDocument(read:ReadProjectDocument):unknown{return read.originalText??structuredClone(read.originalDocument);}

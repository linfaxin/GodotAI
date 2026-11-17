import {canonicalJson,hashBytes,hashJson} from './hash.js';
import {resourcePath} from './paths.js';
import {ProjectToolError} from './errors.js';
import {readProjectStringSetting} from './project-settings.js';
import {createImportReceipt,assessImportReceipt,parseImportReceipt,type ImportAssessment,type ImportReceipt,type ImportTarget,type ImportOutputFormat} from './import-receipts.js';
import {byteMap,borrowByteMap,captureBytes} from './owned-bytes.js';
import {base64Resource} from './base64-resource.js';
import {inspectPng,validatePngData,inspectJpeg,encodeRgbaPng,encodeCompressedRgbaPng,pngCtex,pcmBinaryResource,resourceBinaryImplementation} from './resource-binary.js';
import {deterministicJpegDecoder} from './resource-jpeg.js';
export {deterministicJpegDecoder} from './resource-jpeg.js';
import {createResourceExecutionCache,cachedResourceExecution,storeResourceExecution,type ResourceExecutionCache} from './resource-execution-cache.js';
export {createResourceExecutionCache} from './resource-execution-cache.js';
export type {ResourceExecutionCache,ResourceExecutionCacheStorage,ResourceExecutionCacheOptions} from './resource-execution-cache.js';
export {inspectPng,validatePngData,inspectJpeg,encodeRgbaPng,encodeCompressedRgbaPng,pngCtex,pcmBinaryResource} from './resource-binary.js';
export const BINARY_RESOURCE_TARGET_ABI='godot-4.6.1-resources-v2';
export type ResourceOutputFormat=ImportOutputFormat;
const deterministicProducers=new WeakMap<ResourceConverter,string>();
const textCompatibilityProducers=new WeakMap<ResourceConverter,ResourceConverter>();
function builtin<T extends ResourceConverter>(converter:T,adapterCode=''):T {
 if(converter.output)Object.freeze(converter.output);Object.freeze(converter);
 // Cache invalidation also binds the executable serializer implementation.
 // This fingerprint is private cache policy, not emitted project metadata.
 deterministicProducers.set(converter,canonicalJson({producer:converter.convert.toString(),preflight:converter.preflight?.toString()??'',adapterCode,
  binary:resourceBinaryImplementation,helpers:[remap,noParameters,noMipmaps,readPcmWav,decodePcmWav,binaryTarget].map(fn=>fn.toString())}));return converter;
}

export interface ResourceImportRequest {resource:string;converter:string;parameters?:Readonly<Record<string,unknown>>;dependencies?:readonly string[];uid?:string}
export interface ResourceConversionContext {resource:string;uid?:string;parameters:Readonly<Record<string,unknown>>;target:ImportTarget;files:ReadonlyMap<string,Uint8Array>;destination:string;maxOutputBytes?:number;maxDecodedPixels?:number;maxDecodedBytes?:number}
export interface ResourceConverter {
 id:string;version:string;extensions:readonly string[];
 output?:ResourceOutputFormat;
 parameters(input:Readonly<Record<string,unknown>>):Readonly<Record<string,unknown>>;
 preflight?(context:ResourceConversionContext):void|Promise<void>;
 convert(context:ResourceConversionContext):Promise<ReadonlyMap<string,Uint8Array>>|ReadonlyMap<string,Uint8Array>;
}
export interface ResourceConversionLimits {maxOutputBytes?:number;maxDecodedPixels?:number;maxDecodedBytes?:number}
export interface ResourceConversionResult {files:ReadonlyMap<string,Uint8Array>;receipts:readonly ImportReceipt[];assessments:readonly ImportAssessment[];reasons:ReadonlyMap<string,string>;retainedOutputs:readonly {resource:string;path:string}[];telemetry:{executed:number;cacheHits:number}}
/** Bounds this registry's recent successful execution attestations. These are
 * independent of output-cache records and never authorize another registry. */
export interface ResourceExecutionHistoryOptions {maxEntries?:number;maxBytes?:number}
export interface ResourceConverterRegistryOptions {cache?:ResourceExecutionCache;executionHistory?:ResourceExecutionHistoryOptions}
export interface ResourceExecutionHistoryStats {readonly entries:number;readonly bytes:number;readonly maxEntries:number;readonly maxBytes:number}
function fail(message:string):never {throw new ProjectToolError('E_RESOURCE_CONVERTER',message);}
const jsonObject=(value:unknown):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value))return fail('Converter parameters must be a JSON object');
 return JSON.parse(canonicalJson(value));
};
export function parseResourceImportRequest(value:unknown):ResourceImportRequest {
 const input=value as ResourceImportRequest;
 if(!input||typeof input.converter!=='string'||!input.converter||typeof input.resource!=='string')return fail('Invalid resource import request');
 if(Object.keys(input).some(key=>!['resource','converter','parameters','dependencies','uid'].includes(key)))return fail('Unknown resource import request field');
 if(input.uid!==undefined&&(typeof input.uid!=='string'||!/^uid:\/\/[^\s"\\]+$/.test(input.uid)))return fail('Invalid resource UID');
 if(input.dependencies!==undefined&&(!Array.isArray(input.dependencies)||!input.dependencies.every(item=>typeof item==='string')))return fail('Invalid source dependency closure');
 return {resource:resourcePath(input.resource),converter:input.converter,parameters:jsonObject(input.parameters??{}),
  ...(input.dependencies?{dependencies:[...new Set(input.dependencies.map(resourcePath))].sort()}:{}),...(input.uid?{uid:input.uid}:{})};
}
export function parseResourceImports(value:unknown):ResourceImportRequest[] {
 if(!Array.isArray(value))return fail('resourceImports must be an array');
 const requests=value.map(parseResourceImportRequest);
 if(new Set(requests.map(item=>item.resource.toLowerCase())).size!==requests.length)return fail('Duplicate resource import requests');
 return requests;
}
/** A registry holds executable converter versions, not declarations taken from
 * a cached receipt. Only successful execution or a current recipe comparison
 * can establish freshness. Every converter reads owned copies of source bytes. */
export class ResourceConverterRegistry {
 private readonly converters=new Map<string,ResourceConverter>();
 private readonly deterministic=new Map<string,string>();
 private readonly textCompatibility=new Map<string,ResourceConverter>();
 private readonly cache:ResourceExecutionCache;
 // Imported JSON is not an execution receipt from this registry instance.
 // Retain only bounded SHA-256 attestations, not a complete history of receipts.
 // Eviction merely requires another execution (or a verified output-cache hit).
 private readonly executed=new Map<string,true>();
 private readonly executionMaxEntries:number;
 private readonly executionMaxBytes:number;
 private executionBytes=0;
 constructor(options:ResourceConverterRegistryOptions={}){
  this.cache=options.cache??createResourceExecutionCache();
  this.executionMaxEntries=options.executionHistory?.maxEntries??512;
  this.executionMaxBytes=options.executionHistory?.maxBytes??64*1024;
  if(!Number.isSafeInteger(this.executionMaxEntries)||this.executionMaxEntries<0||!Number.isSafeInteger(this.executionMaxBytes)||this.executionMaxBytes<0)fail('Invalid execution history budget');
 }
 /** UTF-16 digest storage is byte-accounted; the entry cap also bounds Map
  * overhead. No source bytes, output bytes or full receipt JSON are retained. */
 get executionHistoryStats():ResourceExecutionHistoryStats {
  return Object.freeze({entries:this.executed.size,bytes:this.executionBytes,maxEntries:this.executionMaxEntries,maxBytes:this.executionMaxBytes});
 }
 private hasExecuted(digest:string):boolean {
  if(!this.executed.has(digest))return false;
  this.executed.delete(digest);this.executed.set(digest,true);return true;
 }
 private rememberExecution(digest:string):void {
  const bytes=digest.length*2;
  if(!this.executionMaxEntries||bytes>this.executionMaxBytes)return;
  if(this.executed.delete(digest))this.executionBytes-=bytes;
  while(this.executed.size>=this.executionMaxEntries||this.executionBytes+bytes>this.executionMaxBytes){
   const first=this.executed.keys().next().value!;
   this.executed.delete(first);this.executionBytes-=first.length*2;
  }
  this.executed.set(digest,true);this.executionBytes+=bytes;
 }
 register(converter:ResourceConverter):this {
  if(!converter.id||!converter.version||this.converters.has(converter.id)||!converter.extensions.length||typeof converter.parameters!=='function'||typeof converter.convert!=='function')fail('Invalid or duplicate converter registration');
  const {id,version,parameters,convert,preflight}=converter;
  const output=converter.output?Object.freeze({...converter.output}):undefined;
  if(output&&(!/^[a-z0-9]{1,16}$/.test(output.extension)||!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(output.resourceType)||typeof output.resourceAbi!=='string'||!output.resourceAbi))fail('Invalid converter output format');
  // A caller may retain the registration object; in-flight identities stay fixed.
  this.converters.set(id,Object.freeze({id,version,...(output?{output}:{}),extensions:Object.freeze([...converter.extensions]),parameters:(input:Readonly<Record<string,unknown>>)=>parameters.call(converter,input),...(preflight?{preflight:(context:ResourceConversionContext)=>preflight.call(converter,context)}:{}),convert:(context:ResourceConversionContext)=>convert.call(converter,context)}));
  const identity=deterministicProducers.get(converter);if(identity)this.deterministic.set(id,identity);
  const compatibility=textCompatibilityProducers.get(converter);if(compatibility){const legacy=compatibility,{parameters:legacyParameters,convert:legacyConvert}=legacy;this.textCompatibility.set(id,Object.freeze({id:legacy.id,version:legacy.version,extensions:Object.freeze([...legacy.extensions]),parameters:(input:Readonly<Record<string,unknown>>)=>legacyParameters.call(legacy,input),convert:(context:ResourceConversionContext)=>legacyConvert.call(legacy,context)}));}
  return this;
 }
 get ids():ReadonlySet<string>{return new Set(this.converters.keys());}
 async run(requests:readonly ResourceImportRequest[],source:ReadonlyMap<string,Uint8Array>,target:ImportTarget,stored:readonly ImportReceipt[]=[],limits:ResourceConversionLimits={}):Promise<ResourceConversionResult>{
  target=JSON.parse(canonicalJson(target));stored=JSON.parse(canonicalJson(stored));
  const maxOutputBytes=limits.maxOutputBytes??64*1024*1024,maxDecodedPixels=limits.maxDecodedPixels??16*1024*1024,maxDecodedBytes=limits.maxDecodedBytes??64*1024*1024;
  if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||!Number.isSafeInteger(maxDecodedPixels)||maxDecodedPixels<1||!Number.isSafeInteger(maxDecodedBytes)||maxDecodedBytes<1)fail('Invalid conversion budget');
  source=byteMap(source);const sourceView=borrowByteMap(source);let outputBytes=0;
  const outputs=new Map<string,Uint8Array>(),receipts:ImportReceipt[]=[],assessments:ImportAssessment[]=[],reasons=new Map<string,string>();
  const parsed=parseResourceImports(requests),retainedOutputs:{resource:string;path:string}[]=[],telemetry={executed:0,cacheHits:0};
  for(const request of parsed){
   const registered=this.converters.get(request.converter);if(!registered)fail(`Converter is not registered: ${request.converter}`);
   // Existing text-v1 callers keep the exact old WAV producer/receipt. New
   // product hosts select resources-v2 explicitly before emitting binary bytes.
   const converter=target.resourceAbi==='godot-4-text-resource-v1'?(this.textCompatibility.get(request.converter)??registered):registered;
   const extension=/\.([^.\/]+)$/.exec(request.resource)?.[1].toLowerCase();
   if(!converter.extensions.includes(extension??''))fail(`${converter.id} cannot read ${request.resource}`);
   const parameters=jsonObject(converter.parameters(request.parameters??{}));
   const metadata=source.get(request.resource+'.import');
   const oldUid=metadata&&readProjectStringSetting(new TextDecoder().decode(metadata),'remap','uid');
   const sidecar=source.get(request.resource+'.uid');let sidecarUid:string|undefined;
   if(sidecar){try{sidecarUid=new TextDecoder('utf-8',{fatal:true}).decode(sidecar).trim();}catch{fail(`Resource UID sidecar is not UTF-8: ${request.resource}`);}
    if(!/^uid:\/\/[^\s"\\]+$/.test(sidecarUid!))fail(`Invalid resource UID sidecar: ${request.resource}`);}
   const identities=[request.uid,oldUid,sidecarUid].filter((value):value is string=>value!==undefined);
   if(new Set(identities).size>1)fail(`Resource UID conflicts with original metadata: ${request.resource}`);
   const uid=identities[0],sourcePaths=[...new Set([request.resource,...(request.dependencies??[])])].sort();
   const files=new Map<string,Uint8Array>();for(const path of sourcePaths){const bytes=sourceView.get(path);if(!bytes)fail(`Missing conversion source ${path}`);files.set(path,new Uint8Array(bytes));}
   const producer={id:converter.id,version:converter.version,...(converter.output?{output:converter.output}:{})};
   const identity=await hashJson({kind:'godotjs-resource-conversion-v1',resource:request.resource,converter:producer,parameters,target,...(uid?{uid}:{}),sources:await Promise.all([...files].map(async([path,bytes])=>({path,sha256:await hashBytes(bytes)})))});
   const cacheKey=converter===registered&&this.deterministic.has(converter.id)?await hashJson({recipe:identity,implementation:this.deterministic.get(converter.id)}):undefined;
   const destination='res://.godot/imported/godotjs-'+identity+'.'+(converter.output?.extension??'tres');
   const inspection={resource:request.resource,...(uid?{uid}:{}),converter:producer,parameters,target,sourcePaths,files:source};
   const context:ResourceConversionContext={resource:request.resource,...(uid?{uid}:{}),parameters,target:JSON.parse(canonicalJson(target)),files,destination,maxOutputBytes:maxOutputBytes-outputBytes,maxDecodedPixels,maxDecodedBytes};
   await converter.preflight?.(context);
   const previous=stored.find(receipt=>receipt.resource===request.resource);
   if(previous)try{
    const old=parseImportReceipt(previous);
    if(old.converter.id===converter.id&&old.converter.version!==converter.version)for(const output of old.outputs)
     if(output.path.startsWith('res://.godot/imported/')&&output.path!==destination&&sourceView.has(output.path))retainedOutputs.push({resource:request.resource,path:output.path});
   }catch{/* Unverified original caches remain in the source view. */}
   const acceptOutputs=(receipt:ImportReceipt,values:ReadonlyMap<string,Uint8Array>)=>{
    for(const output of receipt.outputs){if(outputs.has(output.path))fail(`Converters collide at ${output.path}`);const bytes=values.get(output.path);if(!bytes)fail('Cached converter output is missing');outputBytes+=bytes.byteLength;if(outputBytes>maxOutputBytes)fail('Converted resources exceed the generated byte budget');outputs.set(output.path,bytes);reasons.set(output.path,`Converted by ${converter.id}@${converter.version}`);}
    receipts.push(receipt);assessments.push({resource:request.resource,status:'fresh',reasons:[`Verified registered ${converter.id}@${converter.version}`]});
   };
   if(cacheKey){
    const cached=await cachedResourceExecution(this.cache,cacheKey);
    if(cached&&(await assessImportReceipt(cached.receipt,{...inspection,outputFiles:cached.outputs})).status==='fresh'){
     acceptOutputs(cached.receipt,cached.outputs);telemetry.cacheHits++;continue;
    }
   }
   const assessment=await assessImportReceipt(previous,{...inspection,outputFiles:source});
   if(assessment.status==='fresh'&&this.hasExecuted(await hashJson(previous))){
    acceptOutputs(previous!,sourceView);telemetry.cacheHits++;continue;
   }
   const converted=await converter.convert(context);telemetry.executed++;
   const convertedFiles=new Map<string,Uint8Array>();
   for(const [name,bytes]of converted){
    const path=resourcePath(name);
    if(!(bytes instanceof Uint8Array)||!bytes.length)fail(`Converter produced invalid bytes: ${path}`);
    if(path!==request.resource+'.import'&&!path.startsWith('res://.godot/imported/'))fail(`Converter output escapes artifact import cache: ${path}`);
    if(outputs.has(path)||convertedFiles.has(path))fail(`Converters collide at ${path}`);
    outputBytes+=bytes.byteLength;if(outputBytes>maxOutputBytes)fail('Converted resources exceed the generated byte budget');
    // A registered converter can retain its return value, so acquire ownership here.
    convertedFiles.set(path,captureBytes(bytes));
   }
   if(!convertedFiles.has(destination)||!convertedFiles.has(request.resource+'.import'))fail('Converter must produce its resource and import remap');
   const receipt=await createImportReceipt({...inspection,outputFiles:convertedFiles,outputPaths:[...convertedFiles.keys()]});
   this.rememberExecution(await hashJson(receipt));
   for(const [path,bytes]of convertedFiles){outputs.set(path,bytes);reasons.set(path,`Converted by ${converter.id}@${converter.version}`);}
   receipts.push(receipt);assessments.push({resource:request.resource,status:'fresh',reasons:[`Verified registered ${converter.id}@${converter.version}`]});
   if(cacheKey)await storeResourceExecution(this.cache,cacheKey,receipt,convertedFiles);
  }
  return {files:byteMap(outputs),receipts,assessments,reasons,retainedOutputs,telemetry};
 }
}
function noParameters(input:Readonly<Record<string,unknown>>):Readonly<Record<string,unknown>> {if(Object.keys(input).length)fail('This converter does not accept editor importer parameters');return {};}
const encode=(text:string)=>new TextEncoder().encode(text);
function remap(context:ResourceConversionContext,type:string):Uint8Array {
 return encode('[remap]\nimporter="godotjs-browser"\ntype='+JSON.stringify(type)+'\n'+(context.uid?'uid='+JSON.stringify(context.uid)+'\n':'')+'path='+JSON.stringify(context.destination)+'\n\n[deps]\nsource_file='+JSON.stringify(context.resource)+'\ndest_files=PackedStringArray('+JSON.stringify(context.destination)+')\n');
}
function readPcmWav(bytes:Uint8Array,maxDecodedBytes:number,copyData:boolean):{format:0|1;stereo:boolean;mixRate:number;data:Uint8Array} {
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),word=(offset:number)=>String.fromCharCode(...bytes.subarray(offset,offset+4));
 if(bytes.length<12||word(0)!=='RIFF'||word(8)!=='WAVE'||view.getUint32(4,true)+8!==bytes.length)fail('WAV must contain one complete RIFF/WAVE file');
 let fmt:{channels:number;rate:number;bits:number;align:number}|undefined,data:Uint8Array|undefined;
 for(let cursor=12;cursor<bytes.length;){
  if(cursor+8>bytes.length)fail('Truncated WAV chunk');
  const size=view.getUint32(cursor+4,true),start=cursor+8,end=start+size;if(end>bytes.length)fail('Truncated WAV payload');
  if(word(cursor)==='fmt '){
   if(fmt||size<16||view.getUint16(start,true)!==1)fail('WAV converter supports one uncompressed PCM fmt chunk');
   const channels=view.getUint16(start+2,true),rate=view.getUint32(start+4,true),bits=view.getUint16(start+14,true),align=view.getUint16(start+12,true);
   if(![1,2].includes(channels)||![8,16].includes(bits)||rate<1||rate>384000||align!==channels*bits/8||view.getUint32(start+8,true)!==rate*align)fail('Unsupported or inconsistent PCM WAV format');
   fmt={channels,rate,bits,align};
  }else if(word(cursor)==='data'){if(data)fail('Duplicate WAV data chunk');if(size>maxDecodedBytes)throw new ProjectToolError('E_RESOURCE_BUDGET','PCM payload exceeds its decoded byte budget');data=copyData?bytes.slice(start,end):bytes.subarray(start,end);}
  cursor=end+(size&1);if(cursor>bytes.length)fail('Missing WAV chunk padding');
 }
 if(!fmt||!data||!data.length||data.length%fmt.align)fail('WAV needs complete PCM frames and fmt/data chunks');
 if(copyData&&fmt.bits===8)for(let i=0;i<data.length;i++)data[i]^=128;
 return {format:fmt.bits===8?0:1,stereo:fmt.channels===2,mixRate:fmt.rate,data};
}
export function decodePcmWav(bytes:Uint8Array,maxDecodedBytes=64*1024*1024):{format:0|1;stereo:boolean;mixRate:number;data:Uint8Array} {return readPcmWav(bytes,maxDecodedBytes,true);}
export const pcmWavConverter:ResourceConverter={id:'godotjs/wav-pcm',version:'1.1.0-base64',extensions:['wav'],parameters:noParameters,convert(context){
 const pcm=decodePcmWav(context.files.get(context.resource)!);
 const mapping=remap(context,'AudioStreamWAV');
 const resource=base64Resource('[gd_resource type="AudioStreamWAV" format=3]\n\n[resource]\nformat='+pcm.format+'\nstereo='+pcm.stereo+'\nmix_rate='+pcm.mixRate+'\ndata=PackedByteArray("',pcm.data,'")\n',(context.maxOutputBytes??64*1024*1024)-mapping.byteLength);
 return new Map([[context.destination,resource],[context.resource+'.import',mapping]]);
}};
export const legacyPcmWavConverter:ResourceConverter={...pcmWavConverter,id:'godotjs/wav-pcm-base64'};
function binaryTarget(context:ResourceConversionContext):void {
 if(context.target.resourceAbi!==BINARY_RESOURCE_TARGET_ABI)throw new ProjectToolError('E_RESOURCE_ABI',`Binary producers require ${BINARY_RESOURCE_TARGET_ABI}; the legacy text resource target is not compatible`);
}
export const binaryPcmWavConverter:ResourceConverter=builtin({id:'godotjs/wav-pcm',version:'2.0.0-rsrc6',extensions:['wav'],
 output:{extension:'res',resourceType:'AudioStreamWAV',resourceAbi:'godot-4.6.1-rsrc-v6'},parameters:noParameters,
 preflight(context){binaryTarget(context);readPcmWav(context.files.get(context.resource)!,context.maxDecodedBytes??64*1024*1024,false);},
 convert(context){const pcm=decodePcmWav(context.files.get(context.resource)!,context.maxDecodedBytes),mapping=remap(context,'AudioStreamWAV');
  return new Map([[context.destination,pcmBinaryResource(pcm,(context.maxOutputBytes??64*1024*1024)-mapping.byteLength)],[context.resource+'.import',mapping]]);
 }});
textCompatibilityProducers.set(binaryPcmWavConverter,pcmWavConverter);
export interface DecodedRgbaImage {width:number;height:number;rgba:Uint8Array}
export interface ImageDecoder {id:string;version:string;/** Host declaration, not supplied by a project document. */deterministic?:boolean;decode(bytes:Uint8Array,mime:'image/png'|'image/jpeg'):Promise<DecodedRgbaImage>}
function noMipmaps(input:Readonly<Record<string,unknown>>):Readonly<Record<string,unknown>> {
 if(Object.keys(input).some(key=>key!=='mipmaps')||input.mipmaps!==undefined&&input.mipmaps!==false)fail('CTEX image producers support mipmaps=false only');return {mipmaps:false};
}
const ctexOutput:ResourceOutputFormat=Object.freeze({extension:'ctex',resourceType:'CompressedTexture2D',resourceAbi:'godot-4.6.1-ctex-v1'});
/** Explicit recipe: unlike image-rgba, its observable native type is
 * CompressedTexture2D. Source bytes remain in the workspace and artifact. */
export const pngCtexConverter:ResourceConverter=builtin({id:'godotjs/png-ctex',version:'1.0.0-png8',extensions:['png'],output:ctexOutput,parameters:noMipmaps,
 preflight(context){binaryTarget(context);inspectPng(context.files.get(context.resource)!,context.maxDecodedPixels,context.maxDecodedBytes);},
 async convert(context){const source=context.files.get(context.resource)!,png=inspectPng(source,context.maxDecodedPixels,context.maxDecodedBytes);await validatePngData(png);
  const mapping=remap(context,'CompressedTexture2D');return new Map([[context.destination,pngCtex(source,png,(context.maxOutputBytes??64*1024*1024)-mapping.byteLength)],[context.resource+'.import',mapping]]);
 }});
export function jpegCtexConverter(decoder:ImageDecoder=deterministicJpegDecoder,options:{compression?:'stored'|'deflate'}={}):ResourceConverter {
 const {id,version,decode,deterministic}=decoder;if(!id||!version||typeof decode!=='function')fail('A JPEG decoder needs an explicit implementation identity and function');
 const compression=options.compression??'deflate';if(!['stored','deflate'].includes(compression))fail('Invalid JPEG PNG compression');
 const decodeImage=decode.bind(decoder),converter:ResourceConverter={id:'godotjs/jpeg-ctex',version:(compression==='stored'?'1.0.0-png-store/':'2.0.0-png-fflate0.8.2-l6-m8/')+id+'/'+version,extensions:['jpg','jpeg'],output:ctexOutput,parameters:noMipmaps,
  preflight(context){binaryTarget(context);inspectJpeg(context.files.get(context.resource)!,context.maxDecodedPixels,context.maxDecodedBytes);},
  async convert(context){const source=context.files.get(context.resource)!,size=inspectJpeg(source,context.maxDecodedPixels,context.maxDecodedBytes),mapping=remap(context,'CompressedTexture2D');
   const limit=(context.maxOutputBytes??64*1024*1024)-mapping.byteLength-60;
   const row=size.width*4+1,raw=row*size.height,encoded=57+2+raw+Math.ceil(raw/65535)*5+4;
   if(compression==='stored'?encoded>limit:limit<68)throw new ProjectToolError('E_RESOURCE_BUDGET','JPEG decoded PNG exceeds its output budget before decoding');
   const image=await decodeImage(source,'image/jpeg');
   if(image.width!==size.width||image.height!==size.height||!(image.rgba instanceof Uint8Array)||image.rgba.length!==size.width*size.height*4)fail('JPEG decoder returned inconsistent frame dimensions or bytes');
   const png=(compression==='stored'?encodeRgbaPng:encodeCompressedRgbaPng)(image,limit);return new Map([[context.destination,pngCtex(png,size,(context.maxOutputBytes??64*1024*1024)-mapping.byteLength)],[context.resource+'.import',mapping]]);
  },
 };
 return deterministic?builtin(converter,decode.toString()):converter;
}
export function rgbaImageConverter(decoder:ImageDecoder):ResourceConverter {
 const {id,version,decode}=decoder;
 if(!id||!version||typeof decode!=='function')fail('An image decoder needs an explicit implementation identity and function');
 // Keep the receiver for stateful decoder implementations, but never read a
 // replacement method or identity from the caller's registration object.
 const decodeImage=decode.bind(decoder);
 return {id:'godotjs/image-rgba',version:'1.1.0-base64/'+id+'/'+version,extensions:['png','jpg','jpeg'],parameters(input){
  if(Object.keys(input).some(key=>key!=='mipmaps')||input.mipmaps!==undefined&&input.mipmaps!==false)fail('Image converter supports mipmaps=false only');return {mipmaps:false};
 },async convert(context){
  const image=await decodeImage(context.files.get(context.resource)!,/\.png$/i.test(context.resource)?'image/png':'image/jpeg');
  if(!Number.isInteger(image.width)||!Number.isInteger(image.height)||image.width<1||image.height<1||image.width*image.height>(context.maxDecodedPixels??16*1024*1024)||!(image.rgba instanceof Uint8Array)||image.rgba.length!==image.width*image.height*4)fail('Image decoder returned invalid RGBA pixels');
  const mapping=remap(context,'ImageTexture');
  const resource=base64Resource('[gd_resource type="ImageTexture" load_steps=2 format=3]\n\n[sub_resource type="Image" id="image"]\ndata={"width":'+image.width+',"height":'+image.height+',"format":"RGBA8","mipmaps":false,"data":PackedByteArray("',image.rgba,'")}\n\n[resource]\nimage=SubResource("image")\n',(context.maxOutputBytes??64*1024*1024)-mapping.byteLength);
  return new Map([[context.destination,resource],[context.resource+'.import',mapping]]);
 }};
}
export function createBrowserResourceConverters(decoder?:ImageDecoder,options:ResourceConverterRegistryOptions&{jpegDecoder?:ImageDecoder}={}):ResourceConverterRegistry {
 const registry=new ResourceConverterRegistry(options).register(binaryPcmWavConverter).register(pngCtexConverter).register(legacyPcmWavConverter).register(jpegCtexConverter(options.jpegDecoder??deterministicJpegDecoder));
 if(decoder)registry.register(rgbaImageConverter(decoder));return registry;
}

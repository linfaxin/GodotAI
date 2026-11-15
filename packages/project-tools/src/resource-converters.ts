import {canonicalJson,hashBytes,hashJson} from './hash.js';
import {resourcePath} from './paths.js';
import {ProjectToolError} from './errors.js';
import {readProjectStringSetting} from './project-settings.js';
import {createImportReceipt,assessImportReceipt,type ImportAssessment,type ImportReceipt,type ImportTarget} from './import-receipts.js';

export interface ResourceImportRequest {resource:string;converter:string;parameters?:Readonly<Record<string,unknown>>;dependencies?:readonly string[];uid?:string}
export interface ResourceConversionContext {resource:string;uid?:string;parameters:Readonly<Record<string,unknown>>;target:ImportTarget;files:ReadonlyMap<string,Uint8Array>;destination:string}
export interface ResourceConverter {
 id:string;version:string;extensions:readonly string[];
 parameters(input:Readonly<Record<string,unknown>>):Readonly<Record<string,unknown>>;
 convert(context:ResourceConversionContext):Promise<ReadonlyMap<string,Uint8Array>>|ReadonlyMap<string,Uint8Array>;
}
export interface ResourceConversionResult {files:ReadonlyMap<string,Uint8Array>;receipts:readonly ImportReceipt[];assessments:readonly ImportAssessment[];reasons:ReadonlyMap<string,string>}
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
 // Imported JSON is not an execution receipt from this registry instance.
 // Cross-session caches are reconstructed once before they may be reused.
 private readonly executed=new Set<string>();
 register(converter:ResourceConverter):this {
  if(!converter.id||!converter.version||this.converters.has(converter.id)||!converter.extensions.length)fail('Invalid or duplicate converter registration');
  this.converters.set(converter.id,converter);return this;
 }
 get ids():ReadonlySet<string>{return new Set(this.converters.keys());}
 async run(requests:readonly ResourceImportRequest[],source:ReadonlyMap<string,Uint8Array>,target:ImportTarget,stored:readonly ImportReceipt[]=[]):Promise<ResourceConversionResult>{
  canonicalJson(target);
  const outputs=new Map<string,Uint8Array>(),receipts:ImportReceipt[]=[],assessments:ImportAssessment[]=[],reasons=new Map<string,string>();
  const parsed=parseResourceImports(requests);
  for(const request of parsed){
   const converter=this.converters.get(request.converter);if(!converter)fail(`Converter is not registered: ${request.converter}`);
   const extension=/\.([^.\/]+)$/.exec(request.resource)?.[1].toLowerCase();
   if(!converter.extensions.includes(extension??''))fail(`${converter.id} cannot read ${request.resource}`);
   const parameters=jsonObject(converter.parameters(request.parameters??{}));
   const metadata=source.get(request.resource+'.import');
   const oldUid=metadata&&readProjectStringSetting(new TextDecoder().decode(metadata),'remap','uid');
   if(request.uid&&oldUid&&request.uid!==oldUid)fail(`Resource UID conflicts with original metadata: ${request.resource}`);
   const uid=request.uid??oldUid,sourcePaths=[...new Set([request.resource,...(request.dependencies??[])])].sort();
   const files=new Map<string,Uint8Array>();for(const path of sourcePaths){const bytes=source.get(path);if(!bytes)fail(`Missing conversion source ${path}`);files.set(path,new Uint8Array(bytes));}
   const identity=await hashJson({kind:'godotjs-resource-conversion-v1',resource:request.resource,converter:{id:converter.id,version:converter.version},parameters,target,...(uid?{uid}:{}),sources:await Promise.all([...files].map(async([path,bytes])=>({path,sha256:await hashBytes(bytes)})))});
   const destination='res://.godot/imported/godotjs-'+identity+'.tres';
   const inspection={resource:request.resource,...(uid?{uid}:{}),converter:{id:converter.id,version:converter.version},parameters,target,sourcePaths,files:source};
   const previous=stored.find(receipt=>receipt.resource===request.resource);
   const assessment=await assessImportReceipt(previous,{...inspection,outputFiles:source});
   if(assessment.status==='fresh'&&this.executed.has(canonicalJson(previous))){
    for(const output of previous!.outputs){if(outputs.has(output.path))fail(`Converters collide at ${output.path}`);outputs.set(output.path,new Uint8Array(source.get(output.path)!));reasons.set(output.path,`Verified cached output from ${converter.id}@${converter.version}`);}
    receipts.push(previous!);assessments.push(assessment);continue;
   }
   const converted=await converter.convert({resource:request.resource,...(uid?{uid}:{}),parameters,target,files,destination});
   const convertedFiles=new Map<string,Uint8Array>();
   for(const [name,bytes]of converted){
    const path=resourcePath(name);
    if(!(bytes instanceof Uint8Array)||!bytes.length)fail(`Converter produced invalid bytes: ${path}`);
    if(path!==request.resource+'.import'&&!path.startsWith('res://.godot/imported/'))fail(`Converter output escapes artifact import cache: ${path}`);
    if(outputs.has(path)||convertedFiles.has(path))fail(`Converters collide at ${path}`);
    convertedFiles.set(path,new Uint8Array(bytes));
   }
   if(!convertedFiles.has(destination)||!convertedFiles.has(request.resource+'.import'))fail('Converter must produce its resource and import remap');
   const receipt=await createImportReceipt({...inspection,outputFiles:convertedFiles,outputPaths:[...convertedFiles.keys()]});
   this.executed.add(canonicalJson(receipt));
   for(const [path,bytes]of convertedFiles){outputs.set(path,bytes);reasons.set(path,`Converted by ${converter.id}@${converter.version}`);}
   receipts.push(receipt);assessments.push({resource:request.resource,status:'fresh',reasons:[`Executed registered ${converter.id}@${converter.version}`]});
  }
  return {files:outputs,receipts,assessments,reasons};
 }
}
function noParameters(input:Readonly<Record<string,unknown>>):Readonly<Record<string,unknown>> {if(Object.keys(input).length)fail('This converter does not accept editor importer parameters');return {};}
const encode=(text:string)=>new TextEncoder().encode(text);
function remap(context:ResourceConversionContext,type:string):Uint8Array {
 return encode('[remap]\nimporter="godotjs-browser"\ntype='+JSON.stringify(type)+'\n'+(context.uid?'uid='+JSON.stringify(context.uid)+'\n':'')+'path='+JSON.stringify(context.destination)+'\n\n[deps]\nsource_file='+JSON.stringify(context.resource)+'\ndest_files=PackedStringArray('+JSON.stringify(context.destination)+')\n');
}
export function decodePcmWav(bytes:Uint8Array):{format:0|1;stereo:boolean;mixRate:number;data:Uint8Array} {
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
  }else if(word(cursor)==='data'){if(data)fail('Duplicate WAV data chunk');data=bytes.slice(start,end);}
  cursor=end+(size&1);if(cursor>bytes.length)fail('Missing WAV chunk padding');
 }
 if(!fmt||!data||!data.length||data.length%fmt.align)fail('WAV needs complete PCM frames and fmt/data chunks');
 if(fmt.bits===8)for(let i=0;i<data.length;i++)data[i]^=128;
 return {format:fmt.bits===8?0:1,stereo:fmt.channels===2,mixRate:fmt.rate,data};
}
export const pcmWavConverter:ResourceConverter={id:'godotjs/wav-pcm',version:'1.0.1',extensions:['wav'],parameters:noParameters,convert(context){
 const pcm=decodePcmWav(context.files.get(context.resource)!);
 const resource=encode('[gd_resource type="AudioStreamWAV" format=3]\n\n[resource]\nformat='+pcm.format+'\nstereo='+pcm.stereo+'\nmix_rate='+pcm.mixRate+'\ndata=PackedByteArray('+[...pcm.data].join(',')+')\n');
 return new Map([[context.destination,resource],[context.resource+'.import',remap(context,'AudioStreamWAV')]]);
}};
export interface DecodedRgbaImage {width:number;height:number;rgba:Uint8Array}
export interface ImageDecoder {id:string;version:string;decode(bytes:Uint8Array,mime:'image/png'|'image/jpeg'):Promise<DecodedRgbaImage>}
export function rgbaImageConverter(decoder:ImageDecoder):ResourceConverter {
 if(!decoder.id||!decoder.version)fail('An image decoder needs an explicit implementation identity');
 return {id:'godotjs/image-rgba',version:'1.0.1/'+decoder.id+'/'+decoder.version,extensions:['png','jpg','jpeg'],parameters(input){
  if(Object.keys(input).some(key=>key!=='mipmaps')||input.mipmaps!==undefined&&input.mipmaps!==false)fail('Image converter supports mipmaps=false only');return {mipmaps:false};
 },async convert(context){
  const image=await decoder.decode(context.files.get(context.resource)!,/\.png$/i.test(context.resource)?'image/png':'image/jpeg');
  if(!Number.isInteger(image.width)||!Number.isInteger(image.height)||image.width<1||image.height<1||image.width*image.height>16*1024*1024||!(image.rgba instanceof Uint8Array)||image.rgba.length!==image.width*image.height*4)fail('Image decoder returned invalid RGBA pixels');
  const resource=encode('[gd_resource type="ImageTexture" load_steps=2 format=3]\n\n[sub_resource type="Image" id="image"]\ndata={"width":'+image.width+',"height":'+image.height+',"format":"RGBA8","mipmaps":false,"data":PackedByteArray('+[...image.rgba].join(',')+')}\n\n[resource]\nimage=SubResource("image")\n');
  return new Map([[context.destination,resource],[context.resource+'.import',remap(context,'ImageTexture')]]);
 }};
}
export function createBrowserResourceConverters(decoder?:ImageDecoder):ResourceConverterRegistry {
 const registry=new ResourceConverterRegistry().register(pcmWavConverter);if(decoder)registry.register(rgbaImageConverter(decoder));return registry;
}

/** Source transport is independent of query/compile requests. Binary data crosses
 * the Worker boundary once per change, rather than once per editor query. */
export type EditorSourceValue=string|readonly number[]|Uint8Array;
export type WorkerSourceFiles=Readonly<Record<string,string|Uint8Array>>;
export interface SourceSyncPatch {schemaVersion:1;sequence:number;documentId:string;revision:number;baseRevision:number|null;reset:boolean;changed:Record<string,string|Uint8Array>;removed:string[]}
interface State {documentId:string;revision:number;files:WorkerSourceFiles;sizes:ReadonlyMap<string,number>;bytes:number}
const fail=(detail:string):never=>{throw Error('E_SOURCE_SYNC: '+detail);};
const identity=(documentId:string,revision:number)=>{if(typeof documentId!=='string'||!documentId||documentId.length>256||!Number.isSafeInteger(revision)||revision<0)fail('Invalid document/revision');};
const path=(value:string)=>{if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.includes('\\')||/[\x00-\x1f]/.test(value)||value.split('/').slice(1).some(part=>!part||part==='.'||part==='..'))fail('Invalid source path');return value;};
function equal(left:string|Uint8Array|undefined,right:EditorSourceValue):boolean {
 return typeof left==='string'||typeof right==='string'?left===right:!!left&&left.length===right.length&&left.every((byte,index)=>byte===right[index]);
}
function capture(value:EditorSourceValue):string|Uint8Array {
 if(typeof value==='string')return value;
 if(!(value instanceof Uint8Array)&&(!Array.isArray(value)||!value.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255)))return fail('Invalid binary source');
 return new Uint8Array(value);
}
// Count before allocation: a UTF-16 string can encode to three times its
// length, so encoding first would exceed the byte budget before admission.
function utf8Size(value:string,limit:number):number {
 let bytes=0;
 for(let index=0;index<value.length;index++){
  const code=value.charCodeAt(index);
  if(code<0x80)bytes++;else if(code<0x800)bytes+=2;
  else if(code>=0xd800&&code<=0xdbff&&index+1<value.length&&value.charCodeAt(index+1)>=0xdc00&&value.charCodeAt(index+1)<=0xdfff){bytes+=4;index++;}
  else bytes+=3;
  if(bytes>limit)fail('Source byte budget exceeded');
 }
 return bytes;
}
export class CompilerSourceSender {
 private current?:State;
 private sequence=0;
 private input?:Readonly<Record<string,EditorSourceValue>>;
 reset():void {this.current=undefined;this.input=undefined;}
 prepare(documentId:string,revision:number,input:Readonly<Record<string,EditorSourceValue>>):{patch:SourceSyncPatch;snapshotFiles():WorkerSourceFiles}{
  identity(documentId,revision);const sequence=++this.sequence;const previous=this.current?.documentId===documentId?this.current:undefined;
  if(previous&&revision<previous.revision)fail('Source revision moved backwards');
  if(previous?.revision===revision&&this.input===input){const snapshot=previous.files;return {patch:{schemaVersion:1,sequence,documentId,revision,baseRevision:revision,reset:false,changed:{},removed:[]},snapshotFiles:()=>Object.freeze(Object.fromEntries(Object.entries(snapshot).map(([name,value])=>[name,typeof value==='string'?value:new Uint8Array(value)])))};}
  const files:Record<string,string|Uint8Array>=Object.create(null),changed:Record<string,string|Uint8Array>=Object.create(null),removed:string[]=[];
  for(const [name,value]of Object.entries(input)){
   path(name);const old=previous?.files[name];
   if(equal(old,value)){files[name]=old!;continue;}
   if(previous?.revision===revision)fail('A source revision was reused for different bytes');
   const owned=capture(value);files[name]=owned;changed[name]=typeof owned==='string'?owned:new Uint8Array(owned);
  }
  for(const name of Object.keys(previous?.files??{}))if(!Object.hasOwn(files,name))removed.push(name);
  if(previous?.revision===revision&&removed.length)fail('A source revision was reused for removed files');
  const snapshot=Object.freeze(files);this.current={documentId,revision,files:snapshot,sizes:new Map(),bytes:0};this.input=input;
  return {patch:{schemaVersion:1,sequence,documentId,revision,baseRevision:previous?.revision??null,reset:!previous,changed,removed},
   // Only durable compile pinning materializes the complete immutable view.
   // Completion/check/hover traffic allocates no unchanged binary arrays.
   snapshotFiles:()=>Object.freeze(Object.fromEntries(Object.entries(snapshot).map(([name,value])=>[name,typeof value==='string'?value:new Uint8Array(value)])))};
 }
}
export class CompilerSourceReceiver {
 private current?:State;
 private readonly latest=new Map<string,number>();
 private sequence=0;
 private readonly maxBytes:number;
 constructor(options:{maxBytes?:number}={}){
  this.maxBytes=options.maxBytes??256*1024*1024;
  if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<1||this.maxBytes>256*1024*1024)fail('Invalid source byte budget');
 }
 reset():void {this.current=undefined;}
 apply(patch:SourceSyncPatch):WorkerSourceFiles {
  if(!patch||patch.schemaVersion!==1)fail('Unknown patch schema');if(!Number.isSafeInteger(patch.sequence)||patch.sequence<=this.sequence)fail('E_SOURCE_SYNC_STALE: Transport sequence moved backwards');identity(patch.documentId,patch.revision);
  if(!patch.changed||typeof patch.changed!=='object'||Array.isArray(patch.changed)||!Array.isArray(patch.removed)||typeof patch.reset!=='boolean')fail('Malformed patch');
  const previous=this.current,latest=this.latest.get(patch.documentId);if(latest!==undefined&&patch.revision<latest)fail('Stale document revision');
  if(Object.keys(patch.changed).length>10000||patch.removed.length>10000)fail('Patch file budget exceeded');
  if(patch.reset){if(patch.baseRevision!==null||patch.removed.length||previous?.documentId===patch.documentId&&patch.revision<previous.revision)fail('Stale or malformed reset');}
  else if(!previous||previous.documentId!==patch.documentId||patch.baseRevision!==previous.revision||patch.revision<previous.revision)fail('E_SOURCE_SYNC_BASE: patch does not follow the active document revision');
  const files:Record<string,string|Uint8Array>=Object.assign(Object.create(null),patch.reset?{}:previous!.files),removed=new Set<string>(),sizes=new Map(patch.reset?[]:previous!.sizes);let bytes=patch.reset?0:previous!.bytes;
  for(const name of patch.removed){path(name);if(removed.has(name)||Object.hasOwn(patch.changed,name)||!Object.hasOwn(files,name))fail('Invalid removed path');removed.add(name);bytes-=sizes.get(name)??0;sizes.delete(name);delete files[name];}
  for(const [name,value]of Object.entries(patch.changed)){path(name);if(typeof value!=='string'&&!(value instanceof Uint8Array))fail('Patch binary values must be typed bytes');const available=this.maxBytes-bytes+(sizes.get(name)??0);if(value.length>available)fail('Source byte budget exceeded');const size=typeof value==='string'?utf8Size(value,available):value.byteLength;bytes+=size-(sizes.get(name)??0);if(bytes>this.maxBytes)fail('Source byte budget exceeded');files[name]=capture(value);sizes.set(name,size);}
  if(!patch.reset&&patch.revision===previous!.revision&&(patch.removed.length||Object.keys(patch.changed).length))fail('A source revision was reused for changed files');
  if(Object.keys(files).length>10000)fail('Source file budget exceeded');
  if(patch.reset&&previous?.documentId===patch.documentId&&previous.revision===patch.revision&&(Object.keys(previous.files).length!==Object.keys(files).length||Object.entries(files).some(([name,value])=>!equal(previous.files[name],value))))fail('A source revision was reused for different reset bytes');
  const folded=new Set<string>();for(const name of Object.keys(files)){const key=name.toLowerCase();if(folded.has(key))fail('Case-colliding source paths');folded.add(key);}
  const snapshot=Object.freeze(files);this.current={documentId:patch.documentId,revision:patch.revision,files:snapshot,sizes,bytes};this.sequence=patch.sequence;this.latest.delete(patch.documentId);this.latest.set(patch.documentId,patch.revision);while(this.latest.size>128)this.latest.delete(this.latest.keys().next().value!);return snapshot;
 }
}

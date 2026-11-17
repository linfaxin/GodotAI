/** Bounded reader for ordinary, standalone, unencrypted Godot PCK v3 files.
 * Embedded executables, removals, deltas, encryption and sparse packs are not
 * admitted to ArtifactSets. No directory metadata is trusted without reading it. */
export interface PckIndexEntry {readonly path:string;readonly offset:number;readonly bytes:number;readonly md5:string}
export interface PckIndex {readonly formatVersion:3;readonly engineVersion:readonly [number,number,number];readonly entries:readonly PckIndexEntry[]}
export interface PckReadLimits {maxBytes?:number;maxFiles?:number;verifyContent?:boolean}
const fail=(detail:string):never=>{throw Error('E_PCK_INDEX: '+detail);};
const rotations=[7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
const constants=Array.from({length:64},(_,i)=>Math.floor(Math.abs(Math.sin(i+1))*4294967296)|0);
/** PCK directory MD5 is a format checksum, never the artifact identity. */
export function pckMd5(bytes:Uint8Array):string {
 let a=0x67452301,b=0xefcdab89|0,c=0x98badcfe|0,d=0x10325476;
 const block=(view:DataView,offset:number)=>{let aa=a,bb=b,cc=c,dd=d;
  for(let i=0;i<64;i++){
   const round=i>>>4,k=round===0?i:round===1?(5*i+1)%16:round===2?(3*i+5)%16:(7*i)%16;
   const f=round===0?(bb&cc)|(~bb&dd):round===1?(dd&bb)|(~dd&cc):round===2?bb^cc^dd:cc^(bb|~dd);
   const sum=(aa+f+constants[i]!+view.getInt32(offset+k*4,true))|0,s=rotations[round*4+i%4]!;
   aa=dd;dd=cc;cc=bb;bb=(bb+((sum<<s)|(sum>>>(32-s))))|0;
  }
  a=(a+aa)|0;b=(b+bb)|0;c=(c+cc)|0;d=(d+dd)|0;
 };
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),complete=bytes.length-bytes.length%64;
 for(let offset=0;offset<complete;offset+=64)block(view,offset);
 const rest=bytes.length-complete,padding=new Uint8Array(rest<56?64:128),tail=new DataView(padding.buffer);
 padding.set(bytes.subarray(complete));padding[rest]=128;tail.setBigUint64(padding.length-8,BigInt(bytes.length)*8n,true);
 for(let offset=0;offset<padding.length;offset+=64)block(tail,offset);
 return [a,b,c,d].flatMap(word=>[0,8,16,24].map(shift=>((word>>>shift)&255).toString(16).padStart(2,'0'))).join('');
}
export function canonicalPckPath(value:string):string {
 if(!value||value.startsWith('/')||value.startsWith('res://')||value.trim()!==value||/[\\\x00-\x1f\x7f?#:%]/.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))return fail('Invalid resource path');
 return 'res://'+value;
}
export function readPckIndex(bytes:Uint8Array,limits:PckReadLimits={}):PckIndex {
 if(!(bytes instanceof Uint8Array)||bytes.byteLength<108||bytes.byteLength>(limits.maxBytes??256*1024*1024))return fail('Pack size exceeds bounds');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(view.getUint32(0,true)!==0x43504447||view.getUint32(4,true)!==3||view.getUint32(20,true)!==2)return fail('Only standalone ordinary PCK v3 is supported');
 const integer=(at:number)=>{const n=view.getBigUint64(at,true);if(n>BigInt(Number.MAX_SAFE_INTEGER))return fail('Unsafe 64-bit value');return Number(n);};
 const base=integer(24),directory=integer(32);
 if(base<104||directory<base||directory>bytes.length-4)return fail('Invalid data/directory offsets');
 for(let at=40;at<104;at++)if(bytes[at]!==0)return fail('Unsupported header extension');
 const count=view.getUint32(directory,true);
 if(count>(limits.maxFiles??10000)||count>Math.floor((bytes.length-directory-4)/40))return fail('Directory count exceeds bounds');
 const entries:PckIndexEntry[]=[],seen=new Set<string>(),decoder=new TextDecoder('utf-8',{fatal:true});let cursor=directory+4;
 const requireBytes=(n:number)=>{if(n<0||cursor+n>bytes.length)return fail('Truncated directory');};
 for(let i=0;i<count;i++){
  requireBytes(4);const length=view.getUint32(cursor,true);cursor+=4;
  if(!length||length>4096||length%4)return fail('Invalid path length');requireBytes(length+36);
  const raw=bytes.subarray(cursor,cursor+length);let end=raw.length;while(end&&raw[end-1]===0)end--;
  let name:string;try{name=decoder.decode(raw.subarray(0,end));}catch{return fail('Invalid UTF-8 resource path');}
  const path=canonicalPckPath(name),key=path.toLowerCase();if(seen.has(key))return fail('Duplicate or case-colliding path');seen.add(key);cursor+=length;
  const offset=base+integer(cursor),size=integer(cursor+8);cursor+=16;
  const md5=Array.from(bytes.subarray(cursor,cursor+16),n=>n.toString(16).padStart(2,'0')).join('');cursor+=16;
  const flags=view.getUint32(cursor,true);cursor+=4;
  if(flags!==0||!Number.isSafeInteger(offset)||!Number.isSafeInteger(offset+size)||offset<base||offset+size>directory)return fail('Unsupported flags or out-of-range file');
  if(limits.verifyContent!==false&&pckMd5(bytes.subarray(offset,offset+size))!==md5)return fail('File checksum differs from directory');
  entries.push(Object.freeze({path,offset,bytes:size,md5}));
 }
 if(cursor!==bytes.length)return fail('Trailing directory bytes');
 let previous=base;for(const entry of [...entries].sort((a,b)=>a.offset-b.offset||a.bytes-b.bytes)){if(entry.bytes&&entry.offset<previous)return fail('Overlapping file data');previous=Math.max(previous,entry.offset+entry.bytes);}
 return Object.freeze({formatVersion:3 as const,engineVersion:Object.freeze([view.getUint32(8,true),view.getUint32(12,true),view.getUint32(16,true)] as [number,number,number]),entries:Object.freeze(entries)});
}

import test from 'node:test';
import assert from 'node:assert/strict';
import SparkMD5 from 'spark-md5';
import {createSourceSnapshot,createBuildPlan,prepareBuildPlan,packBuildPlan,snapshotFiles} from '../dist/build-plan.js';
import {prepareEngineProject} from '../dist/engine-project.js';
import {hashBytes,hashJson} from '../dist/hash.js';
import {packProject} from '../dist/pck.js';
import {base64Resource} from '../dist/base64-resource.js';

const encoder=new TextEncoder(),decoder=new TextDecoder();
const launch={kind:'script',module:'/start.ts'};

test('typed snapshots keep source identity and isolate buffers across async hashing and every public read',async()=>{
 const backing=Uint8Array.of(99,0,128,255,88),bytes=backing.subarray(1,4),original=bytes.slice();
 const pending=createSourceSnapshot({'/start.ts':'export function start(){}','/asset.bin':bytes});
 backing.fill(9);const snapshot=await pending;
 const asset=snapshot.files.find(file=>file.path==='res://asset.bin');
 assert(asset.bytes instanceof Uint8Array);asset.bytes.fill(1);asset.bytes.subarray(0).fill(2);new Uint8Array(asset.bytes.buffer).fill(3);
 assert.deepEqual(asset.bytes,original);assert.deepEqual(snapshotFiles(snapshot)['res://asset.bin'],[0,128,255]);
 const identities=await Promise.all([['res://start.ts','utf8',encoder.encode('export function start(){}')],['res://asset.bin','binary',original]].map(async([path,encoding,data])=>({path,encoding,sha256:await hashBytes(data)})));
 identities.sort((a,b)=>a.path<b.path?-1:1);assert.equal(snapshot.sourceHash,await hashJson(identities));
 const digestInput=Uint8Array.of(42,0,128,255,43),digest=hashBytes(digestInput.subarray(1,4));digestInput.fill(0);
 assert.equal(await digest,await hashBytes(original));
});

test('typed binary input stays typed through injected startup adapters and cannot mutate stored sources or outputs',async()=>{
 const plan=await createBuildPlan(await createSourceSnapshot({'/start.ts':'export function start(){}','/asset.bin':Uint8Array.of(0,128,255)}),launch);
 let adapterBytes;
 const prepared=await prepareBuildPlan(plan,{adapterIdentity:'test/typed-adapter-1',prepare(options){
  adapterBytes=options.files['res://asset.bin'];assert(adapterBytes instanceof Uint8Array);
  const result=prepareEngineProject(options);adapterBytes.fill(7);return result;
 }});
 prepared.prepared.files.get('res://asset.bin').fill(8);
 for(const data of prepared.overlay.files.values())data.fill(9);
 assert.deepEqual(prepared.prepared.files.get('res://asset.bin'),Uint8Array.of(0,128,255));
 assert.deepEqual(snapshotFiles(plan.snapshot)['res://asset.bin'],[0,128,255]);
 const direct=prepareEngineProject({files:{'/start.ts':'export function start(){}','/asset.bin':adapterBytes},launch});
 adapterBytes.fill(1);assert.deepEqual(direct.files.get('res://asset.bin'),Uint8Array.of(7,7,7));
});

test('PCK data and directory MD5 cover exact byte views with shared backing storage',()=>{
 const backing=Uint8Array.of(99,1,2,3,88,4,5,77);
 const files=new Map([['res://a.bin',backing.subarray(1,4)],['res://b.bin',backing.subarray(5,7)]]);
 const packed=packProject(files),view=new DataView(packed.pack.buffer);let cursor=Number(view.getBigUint64(32,true))+4;
 for(const [path,bytes]of files){
  const entry=packed.index[path];assert.deepEqual(packed.pack.slice(entry.offset,entry.offset+entry.size),bytes);
  const pathLength=view.getUint32(cursor,true);cursor+=4+pathLength+16;
  const expected=SparkMD5.ArrayBuffer.hash(bytes.slice().buffer,true);
  assert.deepEqual([...packed.pack.subarray(cursor,cursor+16)],[...expected].map(character=>character.charCodeAt(0)));cursor+=20;
 }
 backing.fill(0);assert.deepEqual([...packed.pack.slice(packed.index['res://a.bin'].offset,packed.index['res://a.bin'].offset+3)],[1,2,3]);
 assert.throws(()=>packProject(files,{maxBytes:128}),/PCK byte size/);
 assert.throws(()=>packProject(files,{maxBytes:0}),/Invalid maxBytes/);
});

test('Base64 resource encoder handles padding, views and non-ASCII metadata without Node runtime helpers',()=>{
 for(let length=0;length<40;length++){
  const backing=Uint8Array.from({length:length+4},(_,index)=>(index*79)%256),data=backing.subarray(2,length+2);
  const prefix='// 资源\nPackedByteArray("',suffix='")\n',expected=prefix+Buffer.from(data).toString('base64')+suffix;
  const encoded=base64Resource(prefix,data,suffix);assert.equal(decoder.decode(encoded),expected);
  assert.throws(()=>base64Resource(prefix,data,suffix,encoded.length-1),/E_RESOURCE_BUDGET/);
 }
});

test('typed and legacy input representations produce identical canonical PCK bytes',async()=>{
 const text='export function start(){}',typed=await createBuildPlan(await createSourceSnapshot({'/start.ts':text,'/asset.bin':Uint8Array.of(1,2,3)}),launch);
 const legacy=await createBuildPlan(await createSourceSnapshot({'/asset.bin':[1,2,3],'/start.ts':text}),launch);
 assert.equal(typed.snapshot.sourceHash,legacy.snapshot.sourceHash);
 const a=await packBuildPlan(typed),b=await packBuildPlan(legacy);
 assert.equal(a.plan.buildKey,b.plan.buildKey);assert.equal(a.receipt.artifactId,b.receipt.artifactId);assert.deepEqual(a.pack,b.pack);
});

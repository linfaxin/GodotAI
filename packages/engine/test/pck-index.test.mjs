import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pckMd5,readPckIndex} from '../dist/pck-index.js';

test('PCK MD5 handles empty, padded, long and offset views against Node crypto',()=>{
 for(const size of [0,1,55,56,63,64,65,127,128,10000]){
  const owner=Uint8Array.from({length:size+18},(_,i)=>i*37%256),bytes=owner.subarray(9,9+size);
  assert.equal(pckMd5(bytes),createHash('md5').update(bytes).digest('hex'));
 }
 assert.equal(pckMd5(new TextEncoder().encode('abc')),'900150983cd24fb0d6963f7d28e17f72');
});
test('PCK reader rejects unsupported headers and allocations from untrusted counts',()=>{
 const bytes=new Uint8Array(112),v=new DataView(bytes.buffer);
 assert.throws(()=>readPckIndex(bytes),/E_PCK_INDEX/);
 v.setUint32(0,0x43504447,true);v.setUint32(4,3,true);v.setUint32(20,2,true);v.setBigUint64(24,104n,true);v.setBigUint64(32,108n,true);
 v.setUint32(108,0xffffffff,true);assert.throws(()=>readPckIndex(bytes),/count/);
 v.setUint32(108,0,true);assert.equal(readPckIndex(bytes).entries.length,0);
 v.setUint32(20,3,true);assert.throws(()=>readPckIndex(bytes),/ordinary/);
});

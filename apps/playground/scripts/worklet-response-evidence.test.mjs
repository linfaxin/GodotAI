import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWorkletResponseCollector,assertWorkletResponseEvidence} from './worklet-response-evidence.mjs';

const body=Buffer.from('registerProcessor("original", class extends AudioWorkletProcessor {});');
const sha256=createHash('sha256').update(body).digest('hex'),url='http://preview.test/engine/game.audio.worklet.js';
const etag='"opaque-strong-validator-of-possibly-compressed-representation"';
const assets=new Map([[url,sha256]]);
function response(status,{target=url,tag=etag,bytes=body,conditional=null,bodyError,wait=Promise.resolve()}={}){
 let reads=0;
 return {url:()=>target,status:()=>status,allHeaders:async()=>({...tag===null?{}:{etag:tag}}),request:()=>({allHeaders:async()=>conditional===null?{}:{'if-none-match':conditional}}),body:async()=>{reads++;await wait;if(bodyError)throw bodyError;return bytes;},reads:()=>reads};
}
async function pair(){const collector=createWorkletResponseCollector();return [await collector.capture(response(200)),await collector.capture(response(304))];}

test('actual 200 decoded bytes seed opaque strong ETag; 304 links earlier full URL without reading a body',async()=>{
 const collector=createWorkletResponseCollector(),first=response(200),cached=response(304,{conditional:etag});
 const records=[await collector.capture(first),await collector.capture(cached)];
 assert.equal(first.reads(),1);assert.equal(cached.reads(),0);
 assert.equal(records[0].bodyBase64,body.toString('base64'));assert.equal(records[1].captureKind,'cache-revalidation');
 assert.equal(records[1].requestIfNoneMatch,etag);assert.equal(records[1].revalidatedFrom,1);assert(!Object.hasOwn(records[1],'bodyBase64'));
 assert.doesNotThrow(()=>assertWorkletResponseEvidence(records,assets));
});
test('queued response events retain arrival sequence even while the first real body is pending',async()=>{
 let release;const wait=new Promise(resolve=>{release=resolve;}),collector=createWorkletResponseCollector();
 const first=collector.capture(response(200,{wait})),second=collector.capture(response(304));release();
 const records=await Promise.all([first,second]);assert.deepEqual(records.map(x=>x.sequence),[1,2]);
 assert.doesNotThrow(()=>assertWorkletResponseEvidence(records,assets));
});
test('304 rejects missing, other URL, changed ETag and weak ETag seeds',async()=>{
 const unseeded=createWorkletResponseCollector();await assert.rejects(unseeded.capture(response(304)),/earlier same-URL/);
 for(const options of [{target:url+'?v=other'},{target:url.replace('preview.test','another.test')},{tag:'"changed"'},{tag:'W/'+etag},{tag:null}]){
  const collector=createWorkletResponseCollector();await collector.capture(response(200));
  await assert.rejects(collector.capture(response(304,options)),/E_WORKLET_RESPONSE_EVIDENCE/);
 }
});
test('redirects and 200 body errors never become inferred cache hits',async()=>{
 for(const status of [301,302,303,307,308,404]){
  const collector=createWorkletResponseCollector();await collector.capture(response(200));
  const unexpected=response(status);await assert.rejects(collector.capture(unexpected),/unexpected response status/);assert.equal(unexpected.reads(),0);
 }
 const collector=createWorkletResponseCollector();await collector.capture(response(200));
 await assert.rejects(collector.capture(response(200,{bodyError:Error('Response body is unavailable for redirect responses (300..399)')})),/300\.\.399/);
});
test('strict validation rehashes base64 bytes instead of trusting a claimed SHA',async()=>{
 const original=await pair();
 for(const mutate of [r=>{r[0].bodyBase64=Buffer.from('wrong body').toString('base64');},r=>{r[0].bytes++;},r=>{delete r[0].bodyBase64;},r=>{r[0].bodyBase64+='\n';},r=>{r[0].sha256='0'.repeat(64);},r=>{r[0].captureKind='cache-revalidation';},r=>{r[0].revalidatedFrom=1;}]){
  const records=structuredClone(original);mutate(records);assert.throws(()=>assertWorkletResponseEvidence(records,assets),/E_WORKLET_RESPONSE_EVIDENCE/);
 }
 const collector=createWorkletResponseCollector(),bad=await collector.capture(response(200,{bytes:Buffer.from('wrong body')}));
 assert.throws(()=>assertWorkletResponseEvidence([bad],assets),/wrong body hash/);
});
test('strict validation rejects absent/future/wrong seed, unrelated URL, reordered sequence and naked SHA evidence',async()=>{
 const original=await pair();
 for(const mutate of [r=>{r[1].revalidatedFrom=2;},r=>{delete r[1].revalidatedFrom;},r=>{r[1].etag='"changed"';},r=>{r[1].url=url+'?other';},r=>{r[1].bytes++;},r=>{r[1].bodyBase64='';},r=>{r[1].status=302;},r=>{r[1].sequence=3;},r=>{r[0]={url,sha256};}]){
  const records=structuredClone(original);mutate(records);assert.throws(()=>assertWorkletResponseEvidence(records,assets),/E_WORKLET_RESPONSE_EVIDENCE/);
 }
 assert.throws(()=>assertWorkletResponseEvidence([original[1]],assets),/sequence/);
});
test('two real URL bodies cannot lend cache evidence to one another, even with the same ETag',async()=>{
 const collector=createWorkletResponseCollector(),other=url+'?second';
 const records=[await collector.capture(response(200)),await collector.capture(response(200,{target:other})),await collector.capture(response(304))];
 const expected=new Map([...assets,[other,sha256]]);assert.doesNotThrow(()=>assertWorkletResponseEvidence(records,expected));
 records[2].revalidatedFrom=2;assert.throws(()=>assertWorkletResponseEvidence(records,expected),/unproved cache revalidation/);
});

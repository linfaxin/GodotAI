import {createHash} from 'node:crypto';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw Error('E_WORKLET_RESPONSE_EVIDENCE: '+message);};
const strongETag=value=>typeof value==='string'&&/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
function assertURL(value){
 try{const url=new URL(value);if(typeof value!=='string'||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.href!==value)fail('noncanonical response URL');}catch{fail('invalid response URL');}
}

/** Observe original Playwright response events in arrival order, including the
 * genuine 304 status. Never fetch a replacement, disable caching, or infer a
 * 304 from a body-read error. A strong HTTP validator is opaque: it may hash
 * compressed bytes, whereas Response.body() yields decoded bytes. */
export function createWorkletResponseCollector(){
 const seeds=new Map();let sequence=0,tail=Promise.resolve();
 return {capture(response){
  const observedSequence=++sequence;
  // Reading the body can settle after a later revalidation event. Serialize
  // processing without changing the actual request/response event order.
  const capture=tail.then(async()=>{
   const url=response.url(),status=response.status(),headers=await response.allHeaders();
   const etag=headers.etag??null;assertURL(url);
   if(!strongETag(etag))fail('missing or weak ETag');
   let requestIfNoneMatch=null;
   try{requestIfNoneMatch=(await response.request().allHeaders())['if-none-match']??null;}catch{}
   if(requestIfNoneMatch!==null&&typeof requestIfNoneMatch!=='string')fail('conditional request header');
   if(status===200){
    const body=await response.body();
    if(!Buffer.isBuffer(body)&&!(body instanceof Uint8Array))fail('missing actual response bytes');
    const bytes=Buffer.from(body),record={sequence:observedSequence,url,status,etag,requestIfNoneMatch,captureKind:'response-body',sha256:hash(bytes),bytes:bytes.length,bodyBase64:bytes.toString('base64')};
    seeds.set(url,record);return record;
   }
   if(status===304){
    const seed=seeds.get(url);
    if(!seed||seed.etag!==etag||seed.sequence>=observedSequence)fail('304 lacks earlier same-URL/same-ETag body');
    return {sequence:observedSequence,url,status,etag,requestIfNoneMatch,captureKind:'cache-revalidation',sha256:seed.sha256,bytes:seed.bytes,revalidatedFrom:seed.sequence};
   }
   fail('unexpected response status '+status);
  });
  tail=capture.catch(()=>{});return capture;
 }};
}

/** Independently rehash actual recorded 200 bytes and validate every 304 link.
 * Merely claiming a release SHA, a cache hit, or a future/other-URL seed cannot
 * satisfy runtime acceptance. Counts/declared hashes are also checked by the
 * existing runtime validator. */
export function assertWorkletResponseEvidence(records,expectedAssets){
 if(!Array.isArray(records)||!(expectedAssets instanceof Map))fail('records/assets');
 const seeds=new Map();let sequence=0;
 for(const record of records){
  if(!record||record.sequence!==++sequence)fail('response event sequence');
  assertURL(record.url);
  const expected=expectedAssets.get(record.url);
  if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||record.sha256!==expected)fail('undeclared URL or wrong body hash');
  if(!strongETag(record.etag)||!(record.requestIfNoneMatch===null||typeof record.requestIfNoneMatch==='string')||!Number.isSafeInteger(record.bytes)||record.bytes<0)fail('response metadata');
  if(record.status===200&&record.captureKind==='response-body'){
   if(typeof record.bodyBase64!=='string'||Object.hasOwn(record,'revalidatedFrom'))fail('200 body provenance');
   const body=Buffer.from(record.bodyBase64,'base64');
   if(body.toString('base64')!==record.bodyBase64||body.length!==record.bytes||hash(body)!==record.sha256)fail('captured body bytes differ');
   seeds.set(record.url,record);
  }else if(record.status===304&&record.captureKind==='cache-revalidation'){
   const seed=seeds.get(record.url);
   if(Object.hasOwn(record,'bodyBase64')||!seed||seed.etag!==record.etag||seed.sequence!==record.revalidatedFrom||seed.sequence>=record.sequence||seed.sha256!==record.sha256||seed.bytes!==record.bytes)fail('unproved cache revalidation');
  }else fail('response status/capture kind');
 }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {CompilerWorkerClient} from '../src/compiler-worker-client.ts';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const workers=[],failures=[],resets=[];
 const client=new CompilerWorkerClient(()=>{const worker={sent:[],terminated:false,postMessage(payload){this.sent.push(payload);},terminate(){this.terminated=true;}};workers.push(worker);return worker;},error=>failures.push(error.message),()=>resets.push(true));
 return {client,workers,failures,resets};
}
test('generic load errors settle requests and the next request uses a new Worker',async()=>{
 const f=fixture(),first=f.client.request({id:1,kind:'compile'});await turn();
 const rejected=assert.rejects(first,/Worker/);f.workers[0].onerror(new Event('error'));await rejected;
 assert.equal(f.workers[0].terminated,true);assert.equal(f.failures.length,1);assert.equal(f.resets.length,1);
 const next=f.client.request({id:2,kind:'compile'});await turn();assert.equal(f.workers.length,2);
 f.workers[1].onmessage({data:{id:2,result:'recovered'}});assert.equal((await next).result,'recovered');
});
test('failure settles requests still waiting for pins and releases late pins',async()=>{
 const f=fixture();let finishPin,releases=0;
 const pendingPin=new Promise(resolve=>finishPin=resolve);
 const one=f.client.request({id:1},()=>pendingPin),two=f.client.request({id:2});await turn();
 const a=assert.rejects(one),b=assert.rejects(two);f.workers[0].onerror(new Event('error'));await Promise.all([a,b]);
 assert.equal(f.workers[0].sent.length,0);
 const next=f.client.request({id:3});await turn();f.workers[1].onmessage({data:{id:3}});await next;
 assert.deepEqual(f.workers[1].sent.map(item=>item.id),[3]);
 finishPin({async release(){releases++;}});await turn();assert.equal(releases,1);
});
test('post failure rejects the entire generation and releases acquired pins',async()=>{
 const f=fixture();let releases=0;
 const first=f.client.request({id:1},async()=>({async release(){releases++;}}));
 f.workers[0].postMessage=()=>{throw new DOMException('cannot post','DataCloneError');};
 const second=f.client.request({id:2});await Promise.all([assert.rejects(first,/cannot post/),assert.rejects(second,/cannot post/)]);await turn();
 assert.equal(releases,1);assert.equal(f.workers[0].terminated,true);
});
test('message decoding errors reject pending work and stale replies cannot settle new work',async()=>{
 const f=fixture(),first=f.client.request({id:1});await turn();
 const rejected=assert.rejects(first,/无法读取/);f.workers[0].onmessageerror(new Event('messageerror'));await rejected;
 const next=f.client.request({id:2});await turn();let settled=false;next.then(()=>settled=true);
 f.workers[0].onmessage({data:{id:2}});await turn();assert.equal(settled,false);
 f.workers[1].onmessage({data:{id:2}});await next;
});
test('successful replies release each request pin once',async()=>{
 const f=fixture();let releases=0;
 const pending=f.client.request({id:1},async()=>({async release(){releases++;}}));await turn();
 f.workers[0].onmessage({data:{id:1,result:'ok'}});assert.equal((await pending).result,'ok');assert.equal(releases,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,utimes,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {get} from 'node:http';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
import {createStaticServer} from './serve.mjs';
import {prepareSiteDelivery} from './prepare-site-delivery.mjs';
const request=(url,headers={})=>new Promise((resolve,reject)=>{get(url,{headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));}).on('error',reject);});
test('HTTP variants preserve decoded WASM, explicit gzip and private cache rules',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'playground-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'releases','candidate123');await mkdir(dir,{recursive:true});
 const raw=Buffer.concat([Buffer.from([0,97,115,109,1,0,0,0]),Buffer.from('engine'.repeat(500))]);
 await writeFile(path.join(dir,'game.wasm'),raw);await writeFile(path.join(dir,'index.html'),'<html>entry</html>');
 const report=await prepareSiteDelivery(root,{brotliQuality:4});assert.equal(report.files['releases/candidate123/game.wasm'].bytes,raw.length);
 const server=createStaticServer(root);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+'/releases/candidate123/game.wasm';
 for(const [encoding,decode]of [['gzip',gunzipSync],['br',brotliDecompressSync]]){const r=await request(url,{'accept-encoding':encoding});assert.equal(r.status,200);assert.equal(r.headers['content-encoding'],encoding);assert.equal(r.headers['content-type'],'application/wasm');assert.equal(r.headers['cache-control'],'no-cache');assert.equal(r.headers.vary,'Accept-Encoding');assert.deepEqual(decode(r.bytes),raw);assert.equal((await request(url,{'accept-encoding':encoding,'if-none-match':r.headers.etag})).status,304);}
 const plain=await request(url,{'accept-encoding':'br;q=0, gzip;q=0'});assert.equal(plain.headers['content-encoding'],undefined);assert.deepEqual(plain.bytes,raw);
 const explicit=await request(url+'.gz',{'accept-encoding':'br,gzip'});assert.equal(explicit.headers['content-encoding'],undefined);assert.deepEqual(gunzipSync(explicit.bytes),raw);
 const fetched=await fetch(url,{headers:{'accept-encoding':'br'}});assert.deepEqual(Buffer.from(await fetched.arrayBuffer()),raw);
 const publicServer=createStaticServer(root,{publicImmutable:true});await new Promise(r=>publicServer.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>publicServer.close(r)));
 const base='http://127.0.0.1:'+publicServer.address().port;assert.match((await request(base+'/releases/candidate123/game.wasm')).headers['cache-control'],/immutable/);
 await writeFile(path.join(root,'index.html'),'entry');assert.equal((await request(base+'/')).headers['cache-control'],'no-cache');
 await prepareSiteDelivery(root,{brotliQuality:4});const first=await readFile(path.join(root,'delivery-manifest.json'));await prepareSiteDelivery(root,{brotliQuality:4});assert.deepEqual(await readFile(path.join(root,'delivery-manifest.json')),first);assert(!(await readdir(root,{recursive:true})).some(name=>name.includes('.delivery-')&&name.endsWith('.tmp')));
 const updated=Buffer.from('updated development asset');await writeFile(path.join(dir,'game.wasm'),updated);await utimes(path.join(dir,'game.wasm'),new Date(),new Date(Date.now()+1000));const refreshed=await request(url,{'accept-encoding':'br,gzip'});assert.equal(refreshed.headers['content-encoding'],undefined);assert.deepEqual(refreshed.bytes,updated);
});


test('encoded variants cannot follow a symlink outside the static root',async t=>{
 const base=await mkdtemp(path.join(tmpdir(),'playground-variant-root-')),root=path.join(base,'site');await mkdir(root);t.after(()=>rm(base,{recursive:true,force:true}));
 const raw=Buffer.from('the public raw asset'),outside=path.join(base,'outside.bin');await writeFile(path.join(root,'game.wasm'),raw);await writeFile(outside,'outside fixture must not be served');
 await symlink(outside,path.join(root,'game.wasm.br'));await symlink(outside,path.join(root,'game.wasm.gz'));await symlink(outside,path.join(root,'outside.wasm'));
 const server=createStaticServer(root);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
 for(const encoding of ['br','gzip','br,gzip']){const result=await request(origin+'/game.wasm',{'accept-encoding':encoding});assert.equal(result.status,200);assert.equal(result.headers['content-encoding'],undefined);assert.deepEqual(result.bytes,raw);}
 assert.equal((await request(origin+'/outside.wasm')).status,403);
});

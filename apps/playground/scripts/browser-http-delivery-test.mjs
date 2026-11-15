import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:https';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStaticServer} from './serve.mjs';
import {launchBrowser,withAcceptanceContext,defaultTestDirectory} from './browser-harness.mjs';
const directory=defaultTestDirectory();
const release=JSON.parse(await readFile(path.join(directory,'engine-release.json'),'utf8'));
assert.equal(release.engine.wasm.encoding,undefined,'Native delivery tests verify HTTP decoding of the raw sealed WASM');
const browser=await launchBrowser({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const checks=[],scratchRoot=fileURLToPath(new URL('../../../work/',import.meta.url));await mkdir(scratchRoot,{recursive:true});
const tlsDirectory=await mkdtemp(path.join(scratchRoot,'delivery-tls-'));
try{
 const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(tlsDirectory,'key.pem'),'-out',path.join(tlsDirectory,'cert.pem'),'-subj','/CN=localhost','-days','1','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{encoding:'utf8'});
 if(generated.status!==0)throw Error('E_DELIVERY_TLS_FIXTURE: openssl is required for localhost HTTPS validation');
 const tls={key:await readFile(path.join(tlsDirectory,'key.pem')),cert:await readFile(path.join(tlsDirectory,'cert.pem'))};
 for(const encoding of ['gzip','br']){
  await readFile(path.join(directory,release.engine.wasm.path+(encoding==='br'?'.br':'.gz')));
  const handler=createStaticServer(directory,{allowedEncodings:[encoding]});
  const server=createServer(tls,(req,res)=>{if(req.url==='/__delivery_probe.html'){res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>HTTP asset integrity</title>');return;}handler.emit('request',req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const page=await browser.newPage({ignoreHTTPSErrors:true});
  try{
   await page.goto('https://127.0.0.1:'+server.address().port+'/__delivery_probe.html');
   const result=await page.evaluate(async({asset})=>{const response=await fetch('/'+asset.path,{cache:'no-cache'}),bytes=await response.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');return {encoding:response.headers.get('content-encoding'),mime:response.headers.get('content-type'),bytes:bytes.byteLength,sha256:hash,valid:WebAssembly.validate(bytes)};},{asset:release.engine.wasm});
   assert.equal(result.encoding,encoding);assert.equal(result.mime,'application/wasm');assert.equal(result.bytes,release.engine.wasm.bytes);assert.equal(result.sha256,release.engine.wasm.sha256);assert.equal(result.valid,true);checks.push({...result,encoding,transport:'https'});
  }finally{await page.close();await new Promise(resolve=>server.close(resolve));}
 }
 const report=await withAcceptanceContext({status:'passed',executionScope:'http-delivery',checks},{directory,browser});
 if(process.env.PLAYGROUND_DELIVERY_REPORT){const file=path.resolve(process.env.PLAYGROUND_DELIVERY_REPORT);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await rm(tlsDirectory,{recursive:true,force:true});}

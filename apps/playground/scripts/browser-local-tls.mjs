import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,X509Certificate} from 'node:crypto';
import {get as secureGet} from 'node:https';
import {get} from 'node:http';

/** Trust only this ephemeral local certificate's public key in Chromium.
 * No certificate errors or browser security policies are disabled globally. */
export async function createLocalTestTls(){
 const directory=await mkdtemp(path.join(tmpdir(),'godotjs-browser-tls-'));
 const keyPath=path.join(directory,'key.pem'),certPath=path.join(directory,'cert.pem');
 try{
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
  const [key,cert]=await Promise.all([readFile(keyPath),readFile(certPath)]);
  const parsed=new X509Certificate(cert),publicKey=parsed.publicKey.export({type:'spki',format:'der'});
  return {key,cert,spki:createHash('sha256').update(publicKey).digest('base64'),certificateSha256:createHash('sha256').update(parsed.raw).digest('hex'),dispose:()=>rm(directory,{recursive:true,force:true})};
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}

/** Node trusts the exact fixture CA as well; certificate validation stays on. */
export function inspectTestSite(url,tls){return new Promise((resolve,reject)=>{
 const request=(new URL(url).protocol==='https:'?secureGet:get)(url,tls?{ca:tls.cert}:{},response=>{response.resume();response.on('end',()=>resolve({status:response.statusCode,headers:response.headers}));});
 request.on('error',reject);
});}

export function localDeploymentEvidence({tls,editorOrigin,previewOrigin,headers}){
 return {kind:tls?'production-equivalent-local-https':'local-http-fixture',externalCdn:false,origins:{editor:editorOrigin,preview:previewOrigin},headers,...(tls?{tls:{validation:'chromium-pinned-spki',certificateSha256:tls.certificateSha256,spki:tls.spki}}:{})};
}

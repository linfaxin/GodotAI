import {readFile,writeFile,readdir,lstat,rm,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync,brotliCompressSync,brotliDecompressSync,constants} from 'node:zlib';
import {digest} from './site-evidence.mjs';
import {randomUUID} from 'node:crypto';
const eligible=new Set(['.wasm','.js','.css','.json','.html','.pck','.map']);
async function atomicWrite(filename,bytes){
 const temporary=filename+'.delivery-'+randomUUID()+'.tmp';
 try{await writeFile(temporary,bytes,{flag:'wx'});await rename(temporary,filename);}
 finally{await rm(temporary,{force:true});}
}
export async function prepareSiteDelivery(directory,{gzipLevel=9,brotliQuality=11}={}){
 if(!Number.isInteger(gzipLevel)||gzipLevel<0||gzipLevel>9||!Number.isInteger(brotliQuality)||brotliQuality<0||brotliQuality>11)throw Error('E_DELIVERY_QUALITY');
 directory=path.resolve(directory);const files={};
 async function walk(prefix=''){
  for(const name of (await readdir(path.join(directory,prefix))).sort()){
   const relative=prefix+name,filename=path.join(directory,relative),info=await lstat(filename);
   if(info.isSymbolicLink())throw Error('E_SITE_SYMLINK: '+relative);
   if(info.isDirectory()){await walk(relative+'/');continue;}
   if(!info.isFile()||relative==='delivery-manifest.json'||!eligible.has(path.extname(name)))continue;
   const raw=await readFile(filename),variants={};
   for(const [encoding,suffix,encode,decode]of [['gzip','.gz',bytes=>gzipSync(bytes,{level:gzipLevel}),gunzipSync],['br','.br',bytes=>brotliCompressSync(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:brotliQuality}}),brotliDecompressSync]]){
    const bytes=encode(raw);if(!decode(bytes).equals(raw))throw Error('E_DELIVERY_ROUNDTRIP: '+relative);
    if(bytes.length>=raw.length){await rm(filename+suffix,{force:true});continue;}
    if(!(await readFile(filename)).equals(raw))throw Error('E_DELIVERY_SOURCE_CHANGED: '+relative);
    await atomicWrite(filename+suffix,bytes);variants[encoding]={path:relative+suffix,bytes:bytes.length,sha256:digest(bytes)};
   }
   files[relative]={bytes:raw.length,sha256:digest(raw),variants};
  }
 }
 await walk();const report={schemaVersion:1,kind:'godotjs-http-delivery',toolchain:{node:process.version,zlib:process.versions.zlib,brotli:process.versions.brotli},gzipLevel,brotliQuality,files};
 await atomicWrite(path.join(directory,'delivery-manifest.json'),JSON.stringify(report,null,2)+'\n');return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 if(!process.argv[2])throw Error('Usage: prepare-site-delivery.mjs <site>');
 const report=await prepareSiteDelivery(process.argv[2]);console.log(JSON.stringify({status:'prepared',files:Object.keys(report.files).length,gzipLevel:report.gzipLevel,brotliQuality:report.brotliQuality}));
}

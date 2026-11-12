import {readFile,readdir,lstat,rm} from 'node:fs/promises';
import path from 'node:path';

export function isDerivedDeliveryMetadata(relative){
 return ['delivery-manifest.json','site-start.json','site-acceptance.json'].includes(relative);
}

/** Raw payload refreshes invalidate every generated transport representation.
 * Only sidecars are removed; a standalone, explicitly encoded input without a
 * matching raw file is retained unless the delivery report declares it derived. */
export async function invalidateSiteDelivery(directory){
 directory=path.resolve(directory);
 const sidecars=new Set();
 try{
  const report=JSON.parse(await readFile(path.join(directory,'delivery-manifest.json'),'utf8'));
  for(const file of Object.values(report.files??{}))for(const variant of Object.values(file.variants??{})){
   const relative=variant?.path;
   if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.split('/').some(part=>!part||part==='.'||part==='..')||! /\.(?:gz|br)$/.test(relative))throw Error('E_DELIVERY_PATH');
   const resolved=path.resolve(directory,relative);if(!resolved.startsWith(directory+path.sep))throw Error('E_DELIVERY_PATH');
   sidecars.add(resolved);
  }
 }catch(error){if(error.code!=='ENOENT')throw error;}
 async function walk(prefix=''){
  for(const entry of await readdir(path.join(directory,prefix),{withFileTypes:true})){
   const relative=prefix+entry.name,filename=path.join(directory,relative);
   if(entry.isSymbolicLink())throw Error('E_SITE_SYMLINK: '+relative);
   if(entry.isDirectory())await walk(relative+'/');
   else if(entry.isFile()&&/\.(?:gz|br)$/.test(entry.name)){
    try{if((await lstat(filename.slice(0,-3))).isFile())sidecars.add(filename);}catch(error){if(error.code!=='ENOENT')throw error;}
   }
  }
 }
 await walk();
 for(const filename of sidecars)await rm(filename,{force:true});
 for(const name of ['delivery-manifest.json','site-start.json','site-acceptance.json'])await rm(path.join(directory,name),{force:true});
 return {removedSidecars:sidecars.size};
}

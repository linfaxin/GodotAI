import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Synthetic editor harnesses still initialize the real worker with exactly
 * the descriptor and candidate bytes served by their test HTTP server. */
export async function runtimeTestContext(directory,releaseRoot){
 const bytes=await readFile(path.join(directory,'engine-release.json')),release=JSON.parse(bytes);
 const context={engineProfile:release.runtimeProfile,engineReleaseId:release.id,descriptorHash:hash(bytes),releaseRoot};
 try{context.demoDescriptorHash=hash(await readFile(path.join(directory,'demo-release.json')));}catch(error){if(error.code!=='ENOENT')throw error;}
 try{const bytes=await readFile(path.join(directory,'manifest.json')),site=JSON.parse(bytes);context.candidateId=hash(bytes);if(site.publicAssets===true)context.publicAssets=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 return context;
}

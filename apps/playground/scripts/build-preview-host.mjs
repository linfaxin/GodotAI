import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
/** This bundle contains no embedded release ID, manifest or React runtime. */
export async function buildPreviewHost(dist,{executionModel='window'}={}){
 const result=await build({entryPoints:[path.join(app,executionModel==='proxy-pthread'?'preview-pthread.ts':'preview.ts')],outfile:path.join(dist,'preview.js'),bundle:true,format:'iife',platform:'browser',target:'es2022',minify:true,sourcemap:true,metafile:true,define:{'process.env.NODE_ENV':'"production"'}});
 if(Object.keys(result.metafile.inputs).some(name=>/(?:^|\/)scripts\/jsb\.react\/|(?:^|\/)node_modules\/(?:\.pnpm\/)?react(?:-reconciler)?[@/]|(?:^|\/)src\/demos\//.test(name.replaceAll('\\','/'))))throw Error('E_ENGINE_HOST_DEPENDENCY: Browser host must not embed React or project code');
 const bytes=await readFile(path.join(dist,'preview.js'));
 return {path:'preview.js',sha256:digest(bytes),bytes:bytes.length};
}
export async function assertPreviewHost(dist,host){
 if(host?.path!=='preview.js'||!Number.isSafeInteger(host.bytes)||host.bytes<=0||!/^[a-f0-9]{64}$/.test(host.sha256??''))throw Error('E_ENGINE_HOST_ASSET');
 const bytes=await readFile(path.join(dist,host.path));
 if(bytes.length!==host.bytes||digest(bytes)!==host.sha256)throw Error('E_ENGINE_HOST_CHANGED');
 return host;
}
export async function writePreviewHtml(dist,host){
 await assertPreviewHost(dist,host);
 const source=await readFile(path.join(app,'preview.html'),'utf8');
 const marker='<script type="module" src="./preview.js"></script>';
 if(source.split(marker).length!==2)throw Error('E_PREVIEW_HOST_SCRIPT: Expected one module script');
 const integrity='sha256-'+Buffer.from(host.sha256,'hex').toString('base64');
 await writeFile(path.join(dist,'preview.html'),source.replace(marker,`<script type="module" src="./preview.js" integrity="${integrity}" crossorigin="anonymous"></script>`));
}

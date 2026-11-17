import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
/** Embed one canonical expression as data; a consumer bundler may rename its
 * own functions, but cannot change the bytes of this generated expression. */
export async function runtimeBindingSourceOutput(directory=root){
 const result=await build({stdin:{contents:'export {createRuntimeBinding} from "./src/runtime-host.ts";',resolveDir:directory,sourcefile:'runtime-binding-factory.ts',loader:'ts'},bundle:true,write:false,minify:true,platform:'neutral',format:'iife',globalName:'GodotJSRuntimeFactory',target:'es2022',legalComments:'none',sourcemap:false});
 const code=result.outputFiles[0].text.trim(),expression='(()=>{'+code+';return GodotJSRuntimeFactory.createRuntimeBinding;})()';
 const source='// Generated from runtime-host.ts by scripts/build-runtime-binding-source.mjs.\n'
  +'export const RUNTIME_BINDING_FACTORY_SOURCE = '+JSON.stringify(expression)+';\n'
  +'export const RUNTIME_BINDING_FACTORY_SHA256 = '+JSON.stringify(createHash('sha256').update(expression).digest('hex'))+';\n';
 const filename=path.join(directory,'src/runtime-binding-source.ts');return {filename,source,expression};
}
export async function buildRuntimeBindingSource(directory=root){const output=await runtimeBindingSourceOutput(directory);if(await readFile(output.filename,'utf8').catch(()=>undefined)!==output.source)await writeFile(output.filename,output.source);return output;}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await buildRuntimeBindingSource();

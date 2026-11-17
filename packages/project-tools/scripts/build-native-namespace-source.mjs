import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function nativeNamespaceSourceOutput(directory=root){
 const result=await build({stdin:{contents:'export {nativeNamespace} from "./src/native-namespace.ts";',resolveDir:directory,sourcefile:'native-namespace-factory.ts',loader:'ts'},bundle:true,write:false,minify:true,platform:'neutral',format:'iife',globalName:'GodotJSNativeNamespace',target:'es2022',legalComments:'none',sourcemap:false});
 const expression='(()=>{'+result.outputFiles[0].text.trim()+';return GodotJSNativeNamespace.nativeNamespace;})()';
 const source='// Generated from native-namespace.ts by scripts/build-native-namespace-source.mjs.\n'
  +'export const NATIVE_NAMESPACE_FACTORY_SOURCE = '+JSON.stringify(expression)+';\n'
  +'export const NATIVE_NAMESPACE_FACTORY_SHA256 = '+JSON.stringify(createHash('sha256').update(expression).digest('hex'))+';\n';
 return {filename:path.join(directory,'src/native-namespace-source.ts'),source,expression};
}
export async function buildNativeNamespaceSource(directory=root){const output=await nativeNamespaceSourceOutput(directory);if(await readFile(output.filename,'utf8').catch(()=>undefined)!==output.source)await writeFile(output.filename,output.source);return output;}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await buildNativeNamespaceSource();

import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function buildFrontend(dist,mainSource){
 const common={bundle:true,format:'iife',platform:'browser',target:'es2022',minify:true,sourcemap:true,define:{'process.env.NODE_ENV':'"production"'}};
 await build({...common,...(mainSource?{stdin:{contents:mainSource,loader:'ts',resolveDir:path.join(app,'src')}}:{entryPoints:[path.join(app,'src/main.ts')]}),outfile:path.join(dist,'main.js'),loader:{'.ttf':'file'},assetNames:'assets/[name]-[hash]'});
 await build({...common,entryPoints:{runner:path.join(app,'src/runner.ts'),'compiler.worker':path.join(app,'src/compiler.worker.ts'),'monaco-editor-worker':path.join(app,'src/monaco-editor-worker.ts')},outdir:dist});
}

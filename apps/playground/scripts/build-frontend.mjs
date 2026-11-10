import {build} from 'esbuild';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function buildFrontend(dist,mainSource){
 await fs.copyFile(path.join(app,'preview.html'),path.join(dist,'preview.html'));
 await fs.mkdir(path.join(dist,"examples"),{recursive:true});
 for(const name of ["engine-features.project.json","advanced-engine.project.json","completion-engine.project.json","parity-engine.project.json","gameplay-engine.project.json","behaviors-engine.project.json","essentials-engine.project.json","interactions-engine.project.json","presentation-engine.project.json","scene-details-engine.project.json","precision-engine.project.json","fidelity-engine.project.json","usability-engine.project.json","composition-engine.project.json","workflows-engine.project.json","refinements-engine.project.json"])await fs.copyFile(path.join(app,"examples",name),path.join(dist,"examples",name));
 const common={bundle:true,format:'iife',platform:'browser',target:'es2022',minify:true,sourcemap:true,define:{'process.env.NODE_ENV':'"production"'}};
 await build({...common,...(mainSource?{stdin:{contents:mainSource,loader:'ts',resolveDir:path.join(app,'src')}}:{entryPoints:[path.join(app,'src/main.ts')]}),outfile:path.join(dist,'main.js'),loader:{'.ttf':'file'},assetNames:'assets/[name]-[hash]'});
 await build({...common,entryPoints:[path.join(app,'preview.ts')],outfile:path.join(dist,'preview.js')});
 await build({...common,entryPoints:{runner:path.join(app,'src/runner.ts'),'compiler.worker':path.join(app,'src/compiler.worker.ts'),'monaco-editor-worker':path.join(app,'src/monaco-editor-worker.ts')},outdir:dist});
}

import {build} from 'esbuild';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {catalog} from '../src/catalog.ts';
import {demoProject} from '../src/project-templates.ts';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function buildFrontend(dist,mainSource){
 await fs.copyFile(path.join(app,'preview.html'),path.join(dist,'preview.html'));
 await fs.rm(path.join(dist,'examples'),{recursive:true,force:true});await fs.mkdir(path.join(dist,'examples'),{recursive:true});
 const demos=await Promise.all(catalog.map(async demo=>({...demo,runtime:'react',source:await fs.readFile(path.join(app,'src/demos',demo.file),'utf8')})));
 await fs.writeFile(path.join(dist,'catalog.json'),JSON.stringify(demos));
 for(const demo of demos)await fs.writeFile(path.join(dist,'examples',demo.id+'.project.json'),JSON.stringify(demoProject(demo),null,2)+'\n');
 const common={bundle:true,format:'iife',platform:'browser',target:'es2022',minify:true,sourcemap:true,define:{'process.env.NODE_ENV':'"production"'}};
 await build({...common,...(mainSource?{stdin:{contents:mainSource,loader:'ts',resolveDir:path.join(app,'src')}}:{entryPoints:[path.join(app,'src/main.ts')]}),outfile:path.join(dist,'main.js'),loader:{'.ttf':'file'},assetNames:'assets/[name]-[hash]'});
 await build({...common,entryPoints:[path.join(app,'preview.ts')],outfile:path.join(dist,'preview.js')});
 await build({...common,entryPoints:{'compiler.worker':path.join(app,'src/compiler.worker.ts'),'monaco-editor-worker':path.join(app,'src/monaco-editor-worker.ts')},outdir:dist});
}

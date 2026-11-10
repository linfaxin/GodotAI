import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
/** The prototype reuses only the scheduler/factory distribution, never the legacy renderer. */
export async function buildReactProbe(){
 const result=await build({entryPoints:[path.join(here,'react-probe.ts')],bundle:true,write:false,format:'cjs',platform:'neutral',target:'es2022',nodePaths:[path.resolve(here,'../../../../scripts/jsb.react/node_modules')],external:['godot','godot-jsb'],define:{'process.env.NODE_ENV':'"development"'},inject:[path.resolve(here,'../../../../scripts/jsb.react/dist/internal/performance.mjs')],sourcemap:'inline'});
 return result.outputFiles[0].text;
}

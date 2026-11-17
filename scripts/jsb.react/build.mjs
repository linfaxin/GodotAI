import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFileSync,renameSync } from 'node:fs';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('.', import.meta.url));
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], {cwd, stdio:'inherit'});
if(result.status !== 0) process.exit(result.status ?? 1);
// Injection requires statically named ESM exports; the package's normal tsc output is CommonJS.
await build({entryPoints:[`${cwd}/src/internal/performance.ts`],outfile:`${cwd}/dist/internal/performance.mjs`,format:'esm',platform:'neutral',target:'es2022',sourcemap:true});
for (const mode of ['development','production']) {
 const result=await build({entryPoints:[`${cwd}/src/internal/reconciler-vendor.ts`],outfile:`${cwd}/dist/reconciler.${mode}.js`,write:false,bundle:true,platform:'neutral',format:'cjs',target:'es2022',sourcemap:true,external:['react'],inject:[`${cwd}/dist/internal/performance.mjs`],define:{'process.env.NODE_ENV':JSON.stringify(mode)},plugins:[{name:'godot-private-scheduler',setup(b){b.onResolve({filter:/^(?:scheduler|\.\.\/scheduler)$/},()=>({path:'./scheduler.js',external:true}));}}]});
 for(const file of result.outputFiles){const temporary=file.path+'.'+process.pid+'.tmp';writeFileSync(temporary,file.contents);renameSync(temporary,file.path);}
}

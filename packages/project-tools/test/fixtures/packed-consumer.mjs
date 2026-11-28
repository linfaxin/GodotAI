import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';

const exec=promisify(execFile),toolsRoot=fileURLToPath(new URL('../..',import.meta.url)),repository=path.resolve(toolsRoot,'../..');
const command=(bin,args,cwd)=>exec(bin,args,{cwd,env:{...process.env,NODE_PATH:''},maxBuffer:16*1024*1024,timeout:180000});

/** Packages must already be built. Packing/installation never rebuild or write
 * shared dist/site output. dispose owns the temporary consumer tree. */
export async function createPackedConsumer({browser=true}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'godotjs-packed-tools-'));
  const dispose=()=>rm(root,{recursive:true,force:true});
  try {
    const artifacts=path.join(root,'artifacts'),directory=path.join(root,'consumer');
    await mkdir(artifacts);await mkdir(directory);
    const declared=JSON.parse(await readFile(path.join(repository,'package.json'),'utf8')).packageManager;
    const expected=/^pnpm@([^+]+)/.exec(declared)?.[1];
    assert.equal((await command('pnpm',['--version'],repository)).stdout.trim(),expected,'fixture uses repository pnpm');
    const tarballs=[],manifests={},packageArtifacts={};
    for(const packageRoot of [path.resolve(toolsRoot,'../engine'),toolsRoot]) {
      const before=new Set(await readdir(artifacts));
      await command('pnpm',['pack','--pack-destination',artifacts],packageRoot);
      const added=(await readdir(artifacts)).filter(name=>!before.has(name)&&name.endsWith('.tgz'));
      assert.equal(added.length,1);
      const tarball=path.join(artifacts,added[0]);tarballs.push(tarball);
      const manifest=JSON.parse((await command('tar',['-xOf',tarball,'package/package.json'],directory)).stdout);
      assert(!JSON.stringify(manifest).includes('workspace:'),'packed manifest has no workspace protocol');
      manifests[manifest.name]=manifest;
      const bytes=await readFile(tarball);
      packageArtifacts[manifest.name]={file:added[0],version:manifest.version,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    }
    const overrides={};
    for(const name of Object.keys(manifests['@godot-js/project-tools'].dependencies??{})) {
      if(name==='@godot-js/engine')continue;
      const metadata=JSON.parse(await readFile(path.join(toolsRoot,'node_modules',name,'package.json'),'utf8'));
      overrides[name]=metadata.version;
    }
    await writeFile(path.join(directory,'package.json'),JSON.stringify({name:'isolated-engine-tools-consumer',private:true,type:'module',overrides}));
    await command('npm',['install','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',...tarballs],directory);
    for(const name of ['@godot-js/engine','@godot-js/project-tools']) {
      const installed=await realpath(path.join(directory,'node_modules',name));
      assert(installed.startsWith(directory+path.sep),'SDK resolves inside the isolated consumer');
      const manifest=JSON.parse(await readFile(path.join(installed,'package.json'),'utf8'));
      assert.equal(manifest.name,name);
      for(const entry of Object.values(manifest.exports))for(const field of ['import','types'])if(entry[field])
        await readFile(path.join(installed,entry[field]));
    }
    const execute=async(source,name='consume.mjs')=>{
      await writeFile(path.join(directory,name),source);
      return command(process.execPath,[name],directory);
    };
    let browserBundle,browserInputs;
    if(browser) {
      const consumerRequire=createRequire(path.join(directory,'package.json'));
      const {build}=consumerRequire('esbuild');
      const entry=path.join(directory,'browser-consumer.mjs');
      await writeFile(entry,await readFile(new URL('./packed-browser-consumer.mjs',import.meta.url)));
      const bundled=await build({absWorkingDir:directory,entryPoints:[entry],bundle:true,write:false,
        format:'iife',platform:'browser',target:'es2022',minify:true,metafile:true,
        define:{'process.env.NODE_ENV':'"production"'}});
      browserInputs=Object.keys(bundled.metafile.inputs).map(name=>path.resolve(directory,name));
      assert(browserInputs.every(name=>name.startsWith(directory+path.sep)),'browser bundle uses installed packages and its fixture');
      assert(!browserInputs.some(name=>name.includes('apps/playground')));
      browserBundle=bundled.outputFiles[0].text;
      await writeFile(path.join(directory,'browser-consumer.js'),browserBundle);
      await writeFile(path.join(directory,'consumer.html'),'<!doctype html><meta charset="utf-8"><title>Independent engine SDK consumer</title><script src="./browser-consumer.js"></script>');
    }
    return {directory,manifests,packageArtifacts,browserBundle,browserInputs,execute,dispose};
  } catch(error) {await dispose();throw error;}
}

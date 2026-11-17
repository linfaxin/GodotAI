/** Verify that a native run reports and fails for fatal entry, command and cleanup errors. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createSourceSnapshot,createBuildPlan,packBuildPlan} from '../../packages/project-tools/dist/build-plan.js';
import {buildEngineVendor,runtimeModuleSource} from '../../apps/playground/scripts/full-engine-release.mjs';

const args=process.argv.slice(2),option=(key,fallback)=>{const index=args.indexOf(key);return index<0?fallback:args[index+1];};
const binary=path.resolve(option('--godot','tests/bin/godot-host-qjs'));
const out=path.resolve(option('--out','work/native-fatal-probe'));
await fs.mkdir(out,{recursive:true});
const vendor=await buildEngineVendor();
const runtimeModules=Object.fromEntries(Object.entries({'react':'React','@godot-js/react/engine':'engineReact'})
 .map(([name,key])=>[name,new TextEncoder().encode(runtimeModuleSource(key))]));
const cases={
 success:`export function start(ctx:any){console.log('FATAL_PROBE_ENTER success');ctx.mount.get_tree().quit(0);}`,
 startup:`export function start(ctx:any){console.log('FATAL_PROBE_ENTER startup');throw Error('FATAL_PROBE_STARTUP');}`,
 'startup-after-quit':`export function start(ctx:any){console.log('FATAL_PROBE_ENTER startup-after-quit');ctx.mount.get_tree().quit(0);throw Error('FATAL_PROBE_STARTUP_AFTER_QUIT');}`,
 'fatal-with-cleanup':`export function start(ctx:any){console.log('FATAL_PROBE_ENTER fatal-with-cleanup');ctx.lifetime.defer(()=>Promise.resolve().then(()=>{console.log('FATAL_PROBE_CLEANED');}));ctx.mount.get_tree().quit(0);throw Error('FATAL_PROBE_FATAL_WITH_CLEANUP');}`,
 command:`export function start(ctx:any){console.log('FATAL_PROBE_ENTER command');const tree=ctx.mount.get_tree();ctx.host.bindProjectCommand(()=>{console.log('FATAL_PROBE_COMMAND_HANDLER');tree.quit(0);throw Error('FATAL_PROBE_COMMAND');});(globalThis as any).__godotjsRuntimeHost.receiveProjectCommand({type:'probe'});}`,
 cleanup:`export function start(ctx:any){console.log('FATAL_PROBE_ENTER cleanup');ctx.lifetime.defer(()=>{throw Error('FATAL_PROBE_CLEANUP');});ctx.mount.get_tree().quit(0);}`,
};
const results=[];
for(const [name,source] of Object.entries(cases)){
 const directory=path.join(out,name);await fs.mkdir(directory,{recursive:true});
 const snapshot=await createSourceSnapshot({'res://start.ts':source});
 const plan=await createBuildPlan(snapshot,{kind:'script',module:'res://start.ts'});
 const packed=await packBuildPlan(plan,{compilerOptions:{vendor,runtimeModules}});
 const pack=path.join(directory,'application.pck');await fs.writeFile(pack,packed.pack);
 const run=spawnSync(binary,['--headless','--audio-driver','Dummy','--main-pack',pack,'--fixed-fps','60','--quit-after','120'],
  {encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024});
 const log=(run.stdout??'')+(run.stderr??'');await fs.writeFile(path.join(directory,'native.log'),log);
 const expected=name==='success'?0:1;
 const marker=name==='success'?undefined:'FATAL_PROBE_'+name.replaceAll('-','_').toUpperCase();
 const passed=run.status===expected&&log.includes('FATAL_PROBE_ENTER '+name)
  &&(name!=='command'||log.includes('FATAL_PROBE_COMMAND_HANDLER'))
  &&(name!=='fatal-with-cleanup'||log.includes('FATAL_PROBE_CLEANED'))
  &&(!marker||log.includes('[godotjs][runtime] '+marker));
 results.push({name,status:passed?'passed':'failed',exitCode:run.status,expectedExitCode:expected,
  diagnostic:marker?log.includes('[godotjs][runtime] '+marker):undefined,log:path.join(directory,'native.log'),error:run.error?.message});
}
const report={kind:'native-fatal-probe',binary,binarySha256:createHash('sha256').update(await fs.readFile(binary)).digest('hex'),
 status:results.every(result=>result.status==='passed')?'passed':'failed',results};
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
assert.equal(report.status,'passed');

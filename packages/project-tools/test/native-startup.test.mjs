import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createSourceSnapshot,createBuildPlan,packBuildPlan} from '../dist/build-plan.js';

// This checks the generated ordinary script bootstrap against the available
// native fixture. It does not certify the new browser Worker execution model.
test('ordinary script launch runs and cleans up in a real GodotJS project',{timeout:20000},async t=>{
 const engine=process.env.GODOT??fileURLToPath(new URL('../../../tests/bin/godot-host-qjs',import.meta.url));
 try{await readFile(engine);}catch{t.skip('Native GodotJS fixture is unavailable');return;}
 const snapshot=await createSourceSnapshot({'/src/start.ts':`import {Node2D,Vector2} from 'godot';
export function start(ctx:any){const child=new Node2D();ctx.mount.add_child(child);child.position=new Vector2(7,9);console.log('PROJECT_TOOLS_START_OK '+child.position.x);ctx.mount.get_tree().quit();return()=>console.log('PROJECT_TOOLS_STOP_OK');}`});
 const artifact=await packBuildPlan(await createBuildPlan(snapshot,{kind:'script',module:'/src/start.ts'}));
 const directory=await mkdtemp(path.join(tmpdir(),'project-tools-start-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const filename=path.join(directory,'project.pck');await writeFile(filename,artifact.pack);
 const run=spawnSync(engine,['--headless','--audio-driver','Dummy','--main-pack',filename,'--quit-after','8'],{cwd:directory,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
 const output=(run.stdout??'')+(run.stderr??'');assert.equal(run.status,0,output);
 assert.match(output,/PROJECT_TOOLS_START_OK 7/,output);assert.match(output,/PROJECT_TOOLS_STOP_OK/,output);
 assert.doesNotMatch(output,/^(?:ERROR:|SCRIPT ERROR:)/m,output);
});

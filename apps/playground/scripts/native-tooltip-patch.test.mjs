import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('native tooltip ownership patch is repeatable and rejects unknown engine layouts',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'godot-tooltip-'));
 try{
  const file=path.join(root,'scene/main/viewport.cpp');await mkdir(path.dirname(file),{recursive:true});
  const original='tooltip_owner->add_child(gui.tooltip_popup);';await writeFile(file,original);
  const run=()=>spawnSync('python3',[new URL('./patch-native-tooltips.py',import.meta.url).pathname,root]);
  assert.equal(run().status,0);const result=await readFile(file,'utf8');assert.match(result,/Node::INTERNAL_MODE_BACK/);
  assert.equal(run().status,0);assert.equal(await readFile(file,'utf8'),result);
  await writeFile(file,original.replace('tooltip_owner','unknown_owner'));assert.notEqual(run().status,0);
  assert.equal(await readFile(file,'utf8'),original.replace('tooltip_owner','unknown_owner'));
 }finally{await rm(root,{recursive:true,force:true});}
});

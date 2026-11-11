import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createTypeSnapshot,writeTypeSnapshot} from './build-shell.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
test('helper declaration edits leave both engine snapshots and their release identity unchanged',async t=>{
 const dist=await fs.mkdtemp(path.join(os.tmpdir(),'playground-types-'));
 t.after(()=>fs.rm(dist,{recursive:true,force:true}));
 const profiles={};
 for(const naming of ['snake','camel']){
  const engineFiles={'/godot/index.d.ts':`export const naming: '${naming}';`,'/godot-jsb/index.d.ts':'export {};','/godot.annotations/index.d.ts':'export {};'};
  const snapshot=await createTypeSnapshot({engineFiles});
  assert.equal(Object.hasOwn(JSON.parse(snapshot),'/api.d.ts'),false);
  const filename=naming==='snake'?'types.json':'types.camel.json';
  profiles[naming]={declarationsSnapshot:{path:`${naming}.declarations.json`},typeSnapshot:{path:filename},typeSnapshotHash:hash(snapshot)};
  await fs.writeFile(path.join(dist,`${naming}.declarations.json`),JSON.stringify(engineFiles));
 }
 const manifest=JSON.stringify({schemaVersion:2,runtimeProfile:'full-engine-v1',id:'fixed-engine-release',api:{namingProfiles:profiles}});
 await fs.writeFile(path.join(dist,'engine-release.json'),manifest);
 await writeTypeSnapshot(dist);
 const before=await Promise.all(['types.json','types.camel.json'].map(name=>fs.readFile(path.join(dist,name),'utf8')));
 const read=fs.readFile;
 // Simulate a source declaration change without modifying the shared checkout.
 t.mock.method(fs,'readFile',async function(file,...args){const value=await read.call(this,file,...args);return String(file).endsWith('/src/editor-api.d.ts')?value+'\nexport function additionalHelper():void;\n':value;});
 await writeTypeSnapshot(dist);
 assert.deepEqual(await Promise.all(['types.json','types.camel.json'].map(name=>fs.readFile(path.join(dist,name),'utf8'))),before);
 assert.equal(await fs.readFile(path.join(dist,'engine-release.json'),'utf8'),manifest);
 // The separation must retain the original engine/SDK drift guard, atomically.
 const changed=JSON.parse(await fs.readFile(path.join(dist,'camel.declarations.json'),'utf8'));
 changed['/godot/index.d.ts']+='\nexport const differentEngine: true;';
 await fs.writeFile(path.join(dist,'camel.declarations.json'),JSON.stringify(changed));
 await assert.rejects(writeTypeSnapshot(dist),/Full engine camel type inputs changed/);
 assert.deepEqual(await Promise.all(['types.json','types.camel.json'].map(name=>fs.readFile(path.join(dist,name),'utf8'))),before);
});

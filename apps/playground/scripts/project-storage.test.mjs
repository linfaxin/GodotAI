import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectStorage} from '../src/project-storage.ts';
import {parseProject,exportProject} from '../src/project-model.ts';
import {defaultProject} from '../src/project-templates.ts';

// An asynchronous transaction fixture: writes become visible only at commit,
// and an injected abort discards every put, including the recovery backup.
function database(initial){
 const records=new Map(initial?[['current',structuredClone(initial)]]:[]);
 const db={records,abortNext:false,commits:[],transaction(_name,mode){
  const staged=new Map([...records].map(([k,v])=>[k,structuredClone(v)])),writes=[];
  let aborted=false,scheduled=false;
  const tx={error:null,objectStore(){return store;},abort(){aborted=true;setImmediate(()=>tx.onabort?.());}};
  const complete=()=>{if(scheduled)return;scheduled=true;setImmediate(()=>{
   if(aborted)return;
   if(mode==='readwrite'&&db.abortNext){db.abortNext=false;tx.error=Error('injected abort');tx.abort();return;}
   if(mode==='readwrite'){records.clear();for(const [k,v]of staged)records.set(k,v);db.commits.push(writes);}
   tx.oncomplete?.();
  });};
  const store={get(key){const request={};queueMicrotask(()=>{request.result=structuredClone(staged.get(key));request.onsuccess?.();complete();});return request;},put(value,key){staged.set(key,structuredClone(value));writes.push(key);complete();}};
  return tx;
 }};
 return db;
}
const legacy=()=>({schemaVersion:1,demoId:'old',entry:'/src/App.tsx',selected:'/asset.bin',files:{'/src/App.tsx':'export default function App(){return null}','/asset.bin':[0,255],'/project.godot':'config_version=5\n'},controls:{speed:1},mode:'production'});
const snapshot=()=>({selected:'old',projects:[['old',legacy()]],versions:{old:7}});
test('migration commit backs up the complete original snapshot atomically and keeps original export',async()=>{
 const original=snapshot(),db=database(original),storage=createProjectStorage(Promise.resolve(db));
 const loaded=await storage.load();assert.deepEqual(db.records.get('current'),original);assert.deepEqual(loaded.migrated,['old']);
 const project=loaded.snapshot.projects[0][1];assert.equal(project.runtime,'react');storage.stage('old',project);
 const result=await storage.save('old');assert.deepEqual(result.conflicts,[]);assert.deepEqual(db.records.get('recovery'),original);
 const current=db.records.get('current');assert.equal(current.versions.old,8);assert.equal(current.projects[0][1].schemaVersion,2);
 assert.deepEqual(exportProject(current.projects[0][1],'original'),original.projects[0][1]);
 assert.ok(db.commits[0].includes('current')&&db.commits[0].includes('recovery'));
});
test('aborted migration retains original data and pending edits without a partial backup',async()=>{
 const original=snapshot(),db=database(original),storage=createProjectStorage(Promise.resolve(db));storage.remember(original);storage.stage('old',parseProject(legacy()));db.abortNext=true;
 await assert.rejects(storage.save('old'),/injected/);assert.deepEqual(db.records.get('current'),original);assert.equal(db.records.has('recovery'),false);assert.equal(storage.hasPending('old'),true);
 await storage.save('old');assert.equal(db.records.get('current').versions.old,8);
});
test('tabs merge separate projects and reject stale writes to the same project',async()=>{
 const initial={selected:'a',projects:[['a',defaultProject()],['b',defaultProject('react')]],versions:{a:1,b:1}};
 const db=database(initial),a=createProjectStorage(Promise.resolve(db)),b=createProjectStorage(Promise.resolve(db));a.remember(initial);b.remember(initial);
 const one=defaultProject();one.files['/note.txt']='tab a';a.stage('a',one);await a.save('a');
 const two=defaultProject('react');two.files['/note.txt']='tab b';b.stage('b',two);assert.deepEqual((await b.save('b')).conflicts,[]);
 b.stage('a',two);assert.deepEqual((await b.save('a')).conflicts,['a']);assert.equal(b.hasPending('a'),true);
 const rows=new Map(db.records.get('current').projects);assert.equal(rows.get('a').files['/note.txt'],'tab a');assert.equal(rows.get('b').files['/note.txt'],'tab b');
});
test('restoration is versioned, backs up pre-restore data and respects stale-tab conflicts',async()=>{
 const original=snapshot(),db=database(original),a=createProjectStorage(Promise.resolve(db)),b=createProjectStorage(Promise.resolve(db));a.remember(original);b.remember(original);
 const edited=parseProject(legacy());edited.files['/note.txt']='edited';a.stage('old',edited);await a.save('old');
 const before=structuredClone(db.records.get('current'));
 assert.deepEqual((await b.restore()).conflicts,['old']);assert.deepEqual(db.records.get('current'),before);
 const restored=await a.restore();assert.deepEqual(restored.conflicts,[]);assert.equal(restored.snapshot.versions.old,9);assert.deepEqual(db.records.get('recovery'),before);
 assert.equal(restored.snapshot.projects[0][1].runtime,'react');assert.deepEqual(exportProject(restored.snapshot.projects[0][1],'original'),original.projects[0][1]);
 assert.equal(restored.snapshot.projects[0][1].files['/note.txt'],undefined);
});
test('invalid recovery documents abort without replacing current projects or backup',async()=>{
 const original=snapshot(),db=database(original),storage=createProjectStorage(Promise.resolve(db));storage.remember(original);
 await assert.rejects(storage.restore({projects:[['old',{schemaVersion:2,files:{}}]]}));assert.deepEqual(db.records.get('current'),original);assert.equal(db.records.has('recovery'),false);
});

test('replacing a schema2 document from the removed renderer also backs up the complete snapshot',async()=>{
 const old={...legacy(),schemaVersion:2,runtime:'legacy-react'},original={selected:'old',projects:[['old',old]],versions:{old:3}};
 const db=database(original),storage=createProjectStorage(Promise.resolve(db)),loaded=await storage.load();
 assert.deepEqual(loaded.migrated,['old']);storage.stage('old',loaded.snapshot.projects[0][1]);await storage.save('old');
 assert.deepEqual(db.records.get('recovery'),original);const saved=db.records.get('current').projects[0][1];assert.equal(saved.runtime,'react');assert.deepEqual(exportProject(saved,'original'),old);
});

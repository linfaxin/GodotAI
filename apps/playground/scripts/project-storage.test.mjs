import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectStorage,projectDatabaseName,copyLegacyProjectStorage} from '../src/project-storage.ts';
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
  const store={openCursor(){const request={},entries=[...staged];let index=0;const advance=()=>queueMicrotask(()=>{const entry=entries[index++];request.result=entry?{key:entry[0],value:structuredClone(entry[1]),continue:advance}:null;request.onsuccess?.();if(!entry)complete();});advance();return request;},get(key){const request={};queueMicrotask(()=>{request.result=structuredClone(staged.get(key));request.onsuccess?.();complete();});return request;},put(value,key){staged.set(key,structuredClone(value));writes.push(key);complete();}};
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
 const current=db.records.get('current');assert.equal(current.versions.old,8);assert.equal(current.projects[0][1].schemaVersion,3);
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


test('profile namespaces separate full, 2d and legacy database identities',()=>{
 assert.equal(projectDatabaseName('full-engine-v1'),'godotjs-playground-v3:full-engine-v1');
 assert.equal(projectDatabaseName('engine-2d-v1'),'godotjs-playground-v3:engine-2d-v1');
 assert.notEqual(projectDatabaseName('full-engine-v1'),projectDatabaseName('engine-2d-v1'));
 assert.throws(()=>projectDatabaseName('../full'));
});
test('legacy namespace copying is idempotent and never writes the source database',async()=>{
 const old=snapshot(),source=database(old),destination=database();source.records.set('recovery',{projects:[['original',legacy()]]});
 const sourceBefore=structuredClone([...source.records]);assert.equal(await copyLegacyProjectStorage(destination,source),true);
 assert.deepEqual([...source.records],sourceBefore);assert.equal(source.commits.length,0);
 assert.deepEqual(destination.records.get('current'),old);assert.deepEqual(destination.records.get('recovery'),source.records.get('recovery'));
 const changed=structuredClone(old);changed.projects[0][1].files['/later.txt']='old client edit';source.records.set('current',changed);
 assert.equal(await copyLegacyProjectStorage(destination,source),false);assert.deepEqual(destination.records.get('current'),old);assert.deepEqual(source.records.get('current'),changed);
});
test('legacy copy does not overwrite an existing new-namespace project snapshot',async()=>{
 const source=database(snapshot()),current={projects:[['new',defaultProject('godot','engine-2d-v1')]]},destination=database(current);
 assert.equal(await copyLegacyProjectStorage(destination,source),false);assert.deepEqual(destination.records.get('current'),current);
});
test('schema3 reloads do not repeat migrations and retained imports never replace project rows',async()=>{
 const project=defaultProject('react','engine-2d-v1'),initial={projects:[['own',project]],versions:{own:1}},db=database(initial),storage=createProjectStorage(Promise.resolve(db));
 assert.deepEqual((await storage.load()).migrated,[]);
 const unsupported={...project,engineProfile:'future-native-v9'},key=await storage.retainImport(unsupported);
 assert.deepEqual(db.records.get(key),unsupported);assert.deepEqual(db.records.get('last-import'),unsupported);assert.deepEqual(db.records.get('current'),initial);
 storage.stage('own',project);await storage.save('own');assert.equal(db.records.has('recovery'),false);assert.deepEqual((await storage.load()).migrated,[]);
});


test('invalid rows remain stored while their first exact backup survives selection-only saves and reloads',async()=>{
 const invalid={schemaVersion:3,engineProfile:'future-v1',runtime:'react',files:{}},original={selected:'good',projects:[['bad',invalid],['good',defaultProject()]]};
 const db=database(original),storage=createProjectStorage(Promise.resolve(db)),loaded=await storage.load();
 assert.deepEqual(await storage.preserveInvalidSnapshot(loaded.original,[...loaded.invalid.keys()]),original);
 await storage.save('good');assert.deepEqual(new Map(db.records.get('current').projects).get('bad'),invalid);
 const again=await storage.load();assert.deepEqual(await storage.preserveInvalidSnapshot(again.original,[...again.invalid.keys()]),original);
 assert.deepEqual(db.records.get('recovery'),original);
});


test('a copied legacy namespace reports its one-way migration once',async()=>{
 const source=database(snapshot()),destination=database();await copyLegacyProjectStorage(destination,source);const storage=createProjectStorage(Promise.resolve(destination));
 assert.equal(await storage.consumeLegacyMigrationNotice(),true);assert.equal(await storage.consumeLegacyMigrationNotice(),false);assert.equal(source.records.has('legacy-import-v1'),false);
});


test('duplicate project IDs are reported and selection-only save backs up both exact raw documents',async()=>{
 const first=defaultProject(),second=defaultProject('react');first.files['/note.txt']='first document';second.files['/note.txt']='second document';
 const original={selected:'same',projects:[['same',first],['same',second]],versions:{same:1}},db=database(original),storage=createProjectStorage(Promise.resolve(db));
 const loaded=await storage.load();assert.equal(loaded.snapshot.projects.length,2);assert.match(loaded.invalid.get('same'),/重复/);
 await storage.save('same');assert.deepEqual(db.records.get('recovery'),original);
 assert(db.commits.some(keys=>keys.includes('recovery')&&keys.includes('current')),'backup and replacement commit atomically');
 const abortDb=database(original),aborted=createProjectStorage(Promise.resolve(abortDb));await aborted.load();abortDb.abortNext=true;
 await assert.rejects(aborted.save('same'));assert.deepEqual(abortDb.records.get('current'),original);assert.equal(abortDb.records.has('recovery'),false);
});


test('edits staged during a recovery transaction abort it and remain visible and persistable after later edits',async()=>{
 const before=defaultProject(),replacement=defaultProject();before.files['/note.txt']='before';replacement.files['/note.txt']='restored';
 const initial={selected:'same',projects:[['same',before]],versions:{same:1}},db=database(initial),storage=createProjectStorage(Promise.resolve(db));storage.remember(initial);
 const visible=structuredClone(before),restoring=storage.restore({selected:'same',projects:[['same',replacement]]});
 setImmediate(()=>{visible.files['/note.txt']='typed during restore';storage.stage('same',visible);});
 const result=await restoring;assert.equal(result.interrupted,true);assert.equal(result.snapshot,undefined);assert.deepEqual(result.conflicts,['same']);
 assert.deepEqual(db.records.get('current'),initial);assert.equal(db.records.has('recovery'),false);assert.equal(storage.hasPending('same'),true);
 assert.deepEqual((await storage.save('same')).conflicts,[]);visible.files['/later.txt']='later visible edit';storage.stage('same',visible);await storage.save('same');
 const saved=db.records.get('current').projects[0][1];assert.equal(saved.files['/note.txt'],'typed during restore');assert.equal(saved.files['/later.txt'],'later visible edit');
});
test('recovery does not discard unsaved edits in a different project',async()=>{
 const a=defaultProject(),b=defaultProject('react'),initial={selected:'b',projects:[['a',a],['b',b]],versions:{a:1,b:1}},db=database(initial),storage=createProjectStorage(Promise.resolve(db));storage.remember(initial);
 const pending=structuredClone(a);pending.files['/too-large.txt']='x'.repeat(8388609);storage.stage('a',pending);
 const result=await storage.restore(initial);assert.equal(result.snapshot,undefined);assert.equal(result.interrupted,true);assert.deepEqual(result.conflicts,['a']);assert.equal(storage.hasPending('a'),true);assert.deepEqual(db.records.get('current'),initial);
});
test('an edit racing an already committed recovery rejects the old UI snapshot and keeps valid conflict versions',async()=>{
 const before=defaultProject(),replacement=defaultProject();before.files['/note.txt']='before';replacement.files['/note.txt']='restored';
 const initial={selected:'same',projects:[['same',before]],versions:{same:1}},db=database(initial),storage=createProjectStorage(Promise.resolve(db));storage.remember(initial);
 const visible=structuredClone(before),transaction=db.transaction.bind(db);let intercept=true;
 db.transaction=(...args)=>{const tx=transaction(...args);if(args[1]==='readwrite'&&intercept){let handler;Object.defineProperty(tx,'oncomplete',{get:()=>handler,set:fn=>{handler=()=>{intercept=false;tx.abort=()=>{throw Error('commit already complete');};visible.files['/note.txt']='typed at commit';storage.stage('same',visible);fn();};}});}return tx;};
 const result=await storage.restore({selected:'same',projects:[['same',replacement]]});assert.equal(result.interrupted,true);assert.equal(result.snapshot,undefined);assert.equal(storage.hasPending('same'),true);
 assert.deepEqual((await storage.save('same')).conflicts,[]);visible.files['/later.txt']='later';storage.stage('same',visible);await storage.save('same');
 const saved=db.records.get('current').projects[0][1];assert.equal(saved.files['/note.txt'],'typed at commit');assert.equal(saved.files['/later.txt'],'later');
});

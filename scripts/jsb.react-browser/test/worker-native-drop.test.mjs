import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {patchWorkerRuntimeFile} from '../../release/patch-web-worker-runtime.mjs';

const original=await readFile(new URL('./fixtures/godot-4.6.1-input.js',import.meta.url),'utf8');
const source=patchWorkerRuntimeFile('platform/web/js/libs/library_godot_input.js',original).code;
const start=source.indexOf('const GodotInputDragDrop = {'),end=source.indexOf('mergeInto(LibraryManager.library, GodotInputDragDrop);',start);
const script=source.slice(start,end).replace('const GodotInputDragDrop =','const GodotDropLibrary =')+'\nglobalThis.GodotInputDragDrop=GodotDropLibrary.$GodotInputDragDrop;';
const tick=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
const file=(name,options={})=>({isFile:true,file:resolve=>resolve({name,type:'text/plain',size:4,bytes:new ArrayBuffer(4),...options})});

function setup({persistent=false,copyError=null,unlinkError=null}={}){
 const files=new Set(),dirs=new Set(),log=[],errors=[],exits=[];
 let active=true;
 const missing=()=>Object.assign(new Error('missing'),{errno:44});
 const scope={Promise,Error,AggregateError,Math,parseInt,ArrayBuffer,queueMicrotask,setTimeout:fn=>queueMicrotask(fn),GodotConfig:{persistent_drops:persistent},GodotOS:{atexit:fn=>exits.push(fn)},GodotRuntime:{error:error=>errors.push(error)},FS:{mkdir:path=>{dirs.add(path);log.push('mkdir');},unlink:path=>{if(unlinkError)throw unlinkError;if(!files.delete(path))throw missing();log.push('unlink');},rmdir:path=>{if(!dirs.delete(path))throw missing();log.push('rmdir');}},GodotFS:{ENOENT:44,copy_to_fs:(path,data)=>{files.add(path);for(let i=path.lastIndexOf('/');i>0;i=path.lastIndexOf('/',i-1))dirs.add(path.slice(0,i));log.push('copy');if(copyError)throw copyError;}},FileReader:class{readAsArrayBuffer(value){const read=()=>{if(value.readError){this.error=value.readError;this.onerror();}else{this.result=value.bytes;this.onload();}};if(value.onRead)value.onRead(read);else queueMicrotask(read);}}};
 runInNewContext(script,scope);
 const run=(entries,callback=()=>log.push('callback'))=>{
  const completions=[];const event={preventDefault(){},dataTransfer:{items:entries.map(entry=>({getAsEntry:()=>entry}))},godotDropIsActive:()=>active,godotDropComplete:error=>{log.push('complete');completions.push(error);}};
  const pending=scope.GodotInputDragDrop._process_event(event,callback);
  return{pending,completions};
 };
 return{drop:scope.GodotInputDragDrop,run,files,dirs,log,errors,exits,close:()=>{active=false;}};
}

test('drop credit returns only after native copy, callback, cleanup and global reset',async()=>{
 const s=setup();let read;const first=s.run([file('a.txt',{onRead:fn=>{read=fn;}})]);await tick();
 assert.equal(first.completions.length,0);assert.equal(s.drop.running,true);
 const busy=s.run([file('busy.txt')]);await busy.pending;assert.match(busy.completions[0].message,/E_WORKER_DROP_BUSY/);assert.equal(s.drop.running,true);
 read();await first.pending;assert.deepEqual(s.log,['complete','mkdir','copy','callback','unlink','rmdir','complete']);
 assert.equal(first.completions.length,1);assert.equal(first.completions[0],undefined);assert.equal(s.drop.running,false);assert.equal(s.drop.pending_files.length,0);assert.equal(s.drop.promises.length,0);assert.equal(s.files.size,0);
 await s.run([file('next.txt')]).pending;assert.equal(s.drop.running,false);
});

test('a failed read drains other in-flight readers before returning its real error',async()=>{
 const s=setup();let finish;const error=new Error('reader failed');
 const first=s.run([file('slow.txt',{onRead:fn=>{finish=fn;}}),file('failed.txt',{readError:error})]);await tick();
 assert.equal(first.completions.length,0);finish();await first.pending;
 assert.equal(first.completions[0],error);assert.equal(s.log.includes('callback'),false);assert.equal(s.drop.pending_files.length,0);
 const next=s.run([file('clean.txt')]);await next.pending;assert.equal(next.completions[0],undefined);assert.equal(s.files.size,0);
});

test('directory entries drain every asynchronous batch and nested file',async()=>{
 const s=setup();const batches=[[file('one.txt',{relativePath:'folder/one.txt'})],[file('two.txt',{relativePath:'folder/two.txt'})],[]];
 const directory={isDirectory:true,createReader:()=>({readEntries:resolve=>queueMicrotask(()=>resolve(batches.shift()))})};let paths;
 const run=s.run([directory],value=>{paths=value;});await run.pending;
 assert.equal(run.completions[0],undefined);assert.equal(paths.length,1);assert(paths[0].endsWith('/folder'));assert.equal(s.log.filter(value=>value==='copy').length,2);assert.equal(s.files.size,0);assert.equal(s.drop.promises.length,0);
});

test('copy and callback exceptions release native resources and report actual failure',async()=>{
 const copyError=new Error('copy failed'),s=setup({copyError});const run=s.run([file('partial.txt')]);await run.pending;
 assert.equal(run.completions[0],copyError);assert.equal(s.files.size,0);assert.equal(s.drop.pending_files.length,0);
 const callbackError=new Error('callback failed'),next=setup();const failed=next.run([file('callback.txt')],()=>{throw callbackError;});await failed.pending;
 assert.equal(failed.completions[0],callbackError);assert.equal(next.files.size,0);assert.equal(next.drop.running,false);
});

test('directory and synchronous entry errors complete without poisoning the next drop',async()=>{
 const s=setup();const error=new Error('directory denied');const bad={isDirectory:true,createReader:()=>({readEntries:(resolve,reject)=>reject(error)})};const run=s.run([bad]);await run.pending;
 assert.equal(run.completions[0],error);const invalid=s.run([{isFile:false,isDirectory:false}]);await invalid.pending;assert.match(invalid.completions[0].message,/Unrecognized/);
 const clean=s.run([file('clean.txt')]);await clean.pending;assert.equal(clean.completions[0],undefined);
});

test('persistent drop credit follows callback and cleanup remains owned by native exit',async()=>{
 const s=setup({persistent:true});const run=s.run([file('persistent.txt')]);await run.pending;
 assert.equal(run.completions[0],undefined);assert.equal(s.files.size,1);assert.equal(s.exits.length,1);
 await new Promise((resolve,reject)=>s.exits[0](resolve,reject));assert.equal(s.files.size,0);
});

test('cleanup failure is returned with the original copy error instead of being swallowed',async()=>{
 const copyError=new Error('copy failed'),unlinkError=new Error('unlink denied');const s=setup({copyError,unlinkError});const run=s.run([file('partial.txt')]);await run.pending;
 assert(run.completions[0] instanceof AggregateError);assert.deepEqual(run.completions[0].errors,[copyError,unlinkError]);assert.match(run.completions[0].message,/copy failed.*unlink denied/);assert.equal(s.drop.running,false);assert.equal(s.drop.pending_files.length,0);
});

test('closing while a FileReader is pending prevents late FS writes and native callbacks',async()=>{
 const s=setup();let completeRead;const run=s.run([file('late.txt',{onRead:fn=>{completeRead=fn;}})]);await tick();
 s.close();completeRead();await run.pending;
 assert.equal(run.completions.length,1);assert.equal(run.completions[0].name,'AbortError');assert.equal(s.log.includes('copy'),false);assert.equal(s.log.includes('callback'),false);assert.equal(s.drop.pending_files.length,0);assert.equal(s.drop.running,false);assert.equal(s.drop.active_event,null);
});

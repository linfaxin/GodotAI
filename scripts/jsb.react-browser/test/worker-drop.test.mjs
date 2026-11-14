import test from 'node:test';
import assert from 'node:assert/strict';
import {collectDrop,createDropTransfer} from '../dist/worker-drop.js';
import {createWorkerDom} from '../dist/worker-dom.js';

const file=(name,text='bytes')=>new File([text],name,{type:'text/plain'});
const entry=(name,value=file(name))=>({name,isFile:true,isDirectory:false,file(resolve){queueMicrotask(()=>resolve(value));}});
const transfer=roots=>({items:roots.map(root=>({kind:'file',webkitGetAsEntry:()=>root}))});
test('drop collector drains every directory-reader batch before structured cloning files',async()=>{
  let reads=0;const dir={name:'folder',isFile:false,isDirectory:true,createReader(){return {readEntries(resolve){queueMicrotask(()=>resolve([ [entry('one.txt')],[entry('two.txt')],[] ][reads++]));}};}};
  const result=await collectDrop(transfer([dir]),new AbortController().signal);assert.equal(reads,3);
  assert.deepEqual(result[0].children.map(child=>child.path),['folder/one.txt','folder/two.txt']);assert.equal(await result[0].children[1].file.text(),'bytes');
});
test('all root DataTransfer items are snapshotted while the DOM data store is readable',async()=>{
  let readable=true,roots=0;const input={items:['one','two'].map(name=>({kind:'file',getAsEntry(){assert.equal(readable,true);roots++;return entry(name);}}))};
  const pending=collectDrop(input,new AbortController().signal);queueMicrotask(()=>{readable=false;});assert.equal(roots,2);assert.equal((await pending).length,2);
});
test('drop enforces aggregate file, entry, depth and safe-path budgets',async()=>{
  await assert.rejects(collectDrop(transfer([entry('large',file('large','123'))]),new AbortController().signal,{maxBytes:2}),/FILE_BUDGET/);
  await assert.rejects(collectDrop(transfer([entry('a'),entry('b')]),new AbortController().signal,{maxFiles:1}),/FILE_BUDGET/);
  await assert.rejects(collectDrop(transfer([entry('../escape')]),new AbortController().signal),/DROP_PATH/);
  await assert.rejects(collectDrop(transfer([entry('same'),entry('same')]),new AbortController().signal),/DUPLICATE/);
  const dir={name:'root',isDirectory:true,isFile:false,createReader(){let read=false;return {readEntries(resolve){resolve(read?[]:(read=true,[entry('nested')]));}};}};
  await assert.rejects(collectDrop(transfer([dir]),new AbortController().signal,{maxDepth:1}),/ENTRY_BUDGET/);
});
test('run cancellation rejects a pending browser file read and ignores its late completion',async()=>{
  const aborter=new AbortController();let finish,second=0;
  const pending=collectDrop(transfer([{name:'late',isFile:true,isDirectory:false,file(resolve){finish=resolve;}},{name:'next',isFile:true,isDirectory:false,file(resolve){second++;resolve(file('next'));}}]),aborter.signal);
  aborter.abort(Error('closed run'));await assert.rejects(pending,/closed run/);finish(file('late'));await Promise.resolve();assert.equal(second,0);
});
test('worker entries asynchronously provide real Files with complete relative paths',async()=>{
  const payload=[{kind:'directory',path:'folder',children:[{kind:'file',path:'folder/test.txt',file:file('test.txt','cloned bytes')}]}];
  const rebuilt=createDropTransfer(payload,()=>true),root=rebuilt.items[0].webkitGetAsEntry(),reader=root.createReader();let synchronous=true;
  const pending=new Promise(resolve=>reader.readEntries(values=>{assert.equal(synchronous,false);resolve(values);}));synchronous=false;const children=await pending;
  assert.equal(children.length,1);assert.equal(children[0].fullPath,'/folder/test.txt');
  assert.deepEqual(await new Promise(resolve=>reader.readEntries(resolve)),[]);
});
test('worker file/readEntries callbacks are asynchronous and closing-fenced',async()=>{
  const payload=[{kind:'file',path:'folder/test.txt',file:file('test.txt','cloned bytes')}];let active=true,sync=true;
  const rebuilt=createDropTransfer(payload,()=>active),entry=rebuilt.items[0].getAsEntry();
  const received=new Promise(resolve=>entry.file(value=>{assert.equal(sync,false);resolve(value);}));sync=false;const value=await received;
  assert.equal(value.relativePath,'folder/test.txt');assert.equal(await value.text(),'cloned bytes');
  active=false;await assert.rejects(new Promise((resolve,reject)=>entry.file(resolve,reject)),/CLOSED/);
});
test('worker retains one drop credit until the native completion hook and releases exactly once',()=>{
  class Canvas extends EventTarget {}const canvas=new Canvas(),commands=[],scope={OffscreenCanvas:Canvas,URL,navigator:{}};
  const dom=createWorkerDom({canvas,scope,geometry:{width:20,height:20,dpr:1,epoch:0},sendHostCommand:command=>commands.push(command)});
  let completion;canvas.addEventListener('drop',event=>{completion=event.godotDropComplete;assert.equal(event.dataTransfer.items[0].getAsEntry().isFile,true);});
  const packet={type:'dom-input',sequence:1,target:'canvas',event:'drop',fields:{drop:{dropId:1,entries:[{kind:'file',path:'a',file:file('a')}]}}};
  assert.equal(dom.dispatchInput(packet),true);assert.throws(()=>dom.dispatchInput({...packet,sequence:2}),/DROP_CREDIT/);
  completion();completion(Error('late duplicate'));assert.equal(commands.filter(command=>command.operation==='drop-release').length,1);assert.equal(commands.at(-1).value.dropId,1);
  dom.dispose();completion();assert.equal(commands.filter(command=>command.operation==='drop-release').length,1);
});
test('stop revokes native drop work before DOM metadata is disposed for engine cleanup',async()=>{
  class Canvas extends EventTarget {}const canvas=new Canvas(),scope={OffscreenCanvas:Canvas,URL,navigator:{}},commands=[];
  const dom=createWorkerDom({canvas,scope,geometry:{width:20,height:20,dpr:1,epoch:0},sendHostCommand:command=>commands.push(command)});let event;
  canvas.addEventListener('drop',value=>{event=value;});dom.dispatchInput({type:'dom-input',sequence:1,target:'canvas',event:'drop',fields:{drop:{dropId:1,entries:[{kind:'file',path:'a',file:file('a')}]}}});
  assert.equal(event.godotDropIsActive(),true);dom.revokeInput();assert.equal(event.godotDropIsActive(),false);assert.ok(canvas.style);canvas.style.cursor='';
  await assert.rejects(new Promise((resolve,reject)=>event.dataTransfer.items[0].getAsEntry().file(resolve,reject)),error=>error.name==='AbortError');event.godotDropComplete();assert.equal(commands.some(command=>command.operation==='drop-release'),false);
  dom.dispose();assert.equal(canvas.style,undefined);
});

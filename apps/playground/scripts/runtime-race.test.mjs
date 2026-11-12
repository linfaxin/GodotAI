import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {getEngineProfile} from '../../../scripts/release/engine-profiles.mjs';

// Execute the production preparation and selection functions, with only DOM,
// persistence and the asynchronous preview constructor replaced by small ports.
const source=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('function select(demo:Demo,'),source.indexOf('function fileForm('))+'\n'+source.slice(source.indexOf('async function prepareRuntime(run:boolean){'),source.indexOf('async function start(){'));
const javascript=ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function fixture(){
 let resolvePreview;const pending=new Promise(resolve=>{resolvePreview=resolve;}),nodes=new Map(),compiles=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,setAttribute(name){if(name==='disabled')this.disabled=true;},removeAttribute(name){if(name==='disabled')this.disabled=false;},replaceChildren(){},querySelector(){return this;}});return nodes.get(id);};
 const project={engineProfile:'engine-2d-v1',runtime:'react',entry:'/App.tsx',selected:'/App.tsx',files:{'/App.tsx':'export default function App(){return null;}'},mode:'production'};
 const context={shellOnly:false,current:project,siteEngineProfile:'engine-2d-v1',runtimeSerial:0,ready:false,nativePreview:undefined,nativePreviewPending:undefined,
  $:node,workbench:{setReady(){},resetTabs(){}},editor:{reset(){}},explorer:{reset(){}},status(){},toast(){},onEngineEvent(){},createEnginePreview:()=>pending,compile:()=>compiles.push('compile'),
  protectedProjectIds:new Set(),projects:new Map(),projectEvents:[],activeEngineRevision:-1,clearTimeout,checkTimer:undefined,runSerial:0,checking:0,revision:0,selected:undefined,storage:{stage(){}},
  initialProject:()=>project,setDiagnostics(){},selectFile(){},controls(){},save:async()=>{},document:{querySelectorAll:()=>[]},Option:class{},getEngineProfile};
 vm.createContext(context);vm.runInContext(javascript,context);
 return {context,node,compiles,prepare:run=>vm.runInContext(`prepareRuntime(${run})`,context),select:profile=>{const demo={id:'retained',name:'Retained',controls:[]};context.projects.set(demo.id,{...project,engineProfile:profile});context.demo=demo;return vm.runInContext('select(demo)',context);},resolve:()=>resolvePreview({stop:async()=>{},runner:{state:'idle'}})};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('late preview preparation cannot enable or run an unsupported project selected while loading',async()=>{
 const f=fixture(),old=f.prepare(true);await tick();f.select('future-engine-v9');
 assert.equal(f.context.ready,false);assert.equal(f.node('run').disabled,true);
 f.resolve();await old;
 assert.equal(f.context.ready,false);assert.equal(f.node('run').disabled,true);assert.equal(f.node('check').disabled,true);assert.deepEqual(f.compiles,[]);
});

test('shell-only and unsupported early returns cancel older pending preparation',async()=>{
 for(const kind of ['shell','unsupported']){
  const f=fixture(),old=f.prepare(true);await tick();
  if(kind==='shell')f.context.shellOnly=true;else f.context.current={...f.context.current,engineProfile:'future-engine-v9'};
  await f.prepare(false);f.resolve();await old;
  assert.equal(f.context.ready,false,kind);assert.equal(f.node('run').disabled,true,kind);assert.deepEqual(f.compiles,[],kind);
 }
});

test('the latest compatible preparation remains usable after superseding an older request',async()=>{
 const f=fixture(),old=f.prepare(true);await tick();const latest=f.prepare(false);await tick();f.resolve();await Promise.all([old,latest]);
 assert.equal(f.context.ready,true);assert.equal(f.node('run').disabled,false);assert.deepEqual(f.compiles,[]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {createWorkerDom} from '../dist/worker-dom.js';

// Unmodified Godot 4.6.1-stable, commit 14d19694e0c88a3f9e82d899a0400f27a24c176e.
const upstream=await readFile(new URL('./fixtures/godot-4.6.1-display.js',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(upstream).digest('hex'),'0671fb02f58a32efdaddf6b2817bd23b9d3692f6156a4cb7c3117a957025d6b7');
const geometry={width:100,height:50,dpr:1,epoch:0};
class Canvas extends EventTarget {}
function setup(t){
  const canvas=new Canvas(),scope={OffscreenCanvas:Canvas,URL,navigator:{}},dom=createWorkerDom({canvas,geometry,scope,sendHostCommand(){}});
  t.after(()=>dom.dispose());
  const library={},modes=[],context=vm.createContext({document:dom.document,window:dom.window,LibraryManager:{library},autoAddDeps(){},mergeInto:Object.assign,
    GodotConfig:{canvas},GodotRuntime:{get_func:()=>value=>modes.push(Boolean(value))},GodotEventListeners:{add:(target,type,callback,capture)=>target.addEventListener(type,callback,capture)}});
  vm.runInContext(upstream+'\nObject.assign(GodotDisplayScreen,GodotDisplayScreen.$GodotDisplayScreen);Object.assign(GodotDisplayCursor,GodotDisplayCursor.$GodotDisplayCursor);',context);
  library.godot_js_display_fullscreen_cb(1);
  return {dom,canvas,modes,library};
}
test('official fullscreen callback receives canvas target while bubbling through document on enter and exit',t=>{
  const {dom,canvas,modes}=setup(t),seen=[];
  for(const [target,name] of [[canvas,'canvas'],[dom.document,'document']])target.addEventListener('fullscreenchange',event=>{
    seen.push({name,target:event.target,currentTarget:event.currentTarget,phase:event.eventPhase,bubbles:event.bubbles,fullscreen:dom.document.fullscreenElement});
  });
  dom.applyHostState({type:'dom-state',fullscreen:true});dom.applyHostState({type:'dom-state',fullscreen:false});
  assert.deepEqual(modes,[true,false]);assert.deepEqual(seen.map(x=>x.name),['canvas','document','canvas','document']);
  for(let i=0;i<seen.length;i++){const event=seen[i];assert.equal(event.target,canvas);assert.equal(event.currentTarget,i%2?dom.document:canvas);assert.equal(event.phase,i%2?Event.BUBBLING_PHASE:Event.AT_TARGET);assert.equal(event.bubbles,true);assert.equal(event.fullscreen,i<2?canvas:null);}
  // Arbitrary input fields cannot gain the private trusted-canvas retargeting.
  assert.equal(dom.dispatchInput({type:'dom-input',sequence:1,target:'document',event:'fullscreenchange',fields:{target:canvas,currentTarget:canvas,isTrusted:true}}),true);
  assert.deepEqual(modes,[true,false]);assert.equal(seen.at(-1).target,dom.document);assert.notEqual(seen.at(-1).currentTarget,canvas);
});
test('fullscreen propagation can be stopped on the real canvas without invoking the official document callback',t=>{
  const {dom,canvas,modes}=setup(t);canvas.addEventListener('fullscreenchange',event=>event.stopPropagation());
  dom.applyHostState({type:'dom-state',fullscreen:true});assert.equal(dom.document.fullscreenElement,canvas);assert.deepEqual(modes,[]);
});
test('official pointerlock query follows document state and its event keeps document as target',t=>{
  const {dom,canvas,library}=setup(t),seen=[];
  dom.document.addEventListener('pointerlockchange',event=>seen.push([event.target,event.currentTarget]));
  dom.applyHostState({type:'dom-state',pointerLocked:true});assert.equal(dom.document.pointerLockElement,canvas);assert.equal(library.godot_js_display_cursor_is_locked(),1);
  dom.applyHostState({type:'dom-state',pointerLocked:false});assert.equal(library.godot_js_display_cursor_is_locked(),0);
  assert.deepEqual(seen,[[dom.document,dom.document],[dom.document,dom.document]]);
});

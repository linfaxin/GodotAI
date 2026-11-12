import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {patchPresentationBoundary,PRESENTATION_CONFIG_SHA256,PRESENTATION_BOUNDARY_PATCH} from '../../../scripts/release/patch-web-presentation-boundary.mjs';

const original=await readFile(new URL('../../../scripts/jsb.react-browser/test/fixtures/godot-4.6.1-config.js',import.meta.url),'utf8');
const patched=patchPresentationBoundary(original).code;
const safari='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const chrome='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function contextState(){
 const state={lost:false,read:null,draw:null,calls:[],queries:[],valid:new Set()};
 const gl={FRAMEBUFFER:36160,READ_FRAMEBUFFER:36008,DRAW_FRAMEBUFFER:36009,READ_FRAMEBUFFER_BINDING:36010,DRAW_FRAMEBUFFER_BINDING:36006,
  isContextLost:()=>state.lost,isFramebuffer:fbo=>state.valid.has(fbo),
  bindFramebuffer(target,fbo){assert(!state.lost,'must not bind a lost context');assert(fbo===null||state.valid.has(fbo),'must not restore a deleted FBO');state.calls.push([target,fbo]);if(target===gl.FRAMEBUFFER||target===gl.READ_FRAMEBUFFER)state.read=fbo;if(target===gl.FRAMEBUFFER||target===gl.DRAW_FRAMEBUFFER)state.draw=fbo;},
  getParameter(target){state.queries.push(target);return target===gl.READ_FRAMEBUFFER_BINDING?state.read:state.draw;},
 };
 const read={name:'read'},draw={name:'draw'};state.valid.add(read);state.valid.add(draw);state.read=read;state.draw=draw;
 return {gl,state,read,draw};
}
function executeConfig({ua=safari,touch=0,canvas,wasm}={}){
 class Canvas{constructor(){this.tabIndex=0;this.width=320;this.height=240;}}
 canvas??=new Canvas();
 const sandbox={navigator:{userAgent:ua,maxTouchPoints:touch,languages:['en-US']},HTMLCanvasElement:Canvas,document:{getElementsByTagName:()=>[canvas]},console,WebAssembly:wasm??WebAssembly};
 const context=vm.createContext(sandbox);
 vm.runInContext(patched+'\nglobalThis.createConfig=InternalConfig;',context,{filename:'actual-patched-godot-config.js'});
 return {config:context.createConfig({canvas,locale:'en-US'}),canvas,context};
}
function setup(options){const state=contextState(),execution=executeConfig(options);execution.canvas.GLctxObject={GLctx:state.gl};return {...state,...execution,module:execution.config.getModuleConfig('/engine',{})};}

test('presentation patch pins the entire real config source and rejects drift or partial patches',()=>{
 assert.equal(createHash('sha256').update(original).digest('hex'),PRESENTATION_CONFIG_SHA256);
 const result=patchPresentationBoundary(original);assert.equal(result.patchId,PRESENTATION_BOUNDARY_PATCH);assert.equal(result.changed,true);
 assert.deepEqual(patchPresentationBoundary(patched),{code:patched,changed:false,patchId:PRESENTATION_BOUNDARY_PATCH});
 for(const source of ['',original+'\n',original.replace('unloadAfterInit: true','unloadAfterInit: false'),patched.replace('pending = null;','pending = {};'),patched.replace("'postMainLoop': webkitPresentation ? parkPresentation : undefined,",''),patched+'\n// upstream change'])assert.throws(()=>patchPresentationBoundary(source),/E_PRESENTATION_PATCH_UNSUPPORTED/);
 assert(patched.includes("cfg.canvas['GLctxObject']"));assert(patched.includes("context['GLctx']"));
 assert(!patched.includes('gl.getError('));assert(!patched.includes('gl.readPixels('));
});

test('actual patched config preserves distinct READ/DRAW state, renderer cache identity, and repeated loop boundaries',()=>{
 const {module,state,gl,read,draw,canvas}=setup();
 module.preMainLoop();assert.equal(state.calls.length,0);
 module.postMainLoop();assert.equal(state.read,null);assert.equal(state.draw,null);
 assert.deepEqual(state.calls,[[gl.FRAMEBUFFER,null]]);
 module.postMainLoop(); // A duplicate post must not replace the saved cache with null.
 canvas.width=960;canvas.height=640;
 module.preMainLoop();assert.equal(state.read,read);assert.equal(state.draw,draw);
 assert.deepEqual(state.calls.slice(-2),[[gl.READ_FRAMEBUFFER,read],[gl.DRAW_FRAMEBUFFER,draw]]);
 const calls=state.calls.length;module.preMainLoop();assert.equal(state.calls.length,calls);
 // Foreign GL writes do not redefine Godot's cached state. Supported native
 // React/resource work must run in the engine's process/physics pump.
 module.postMainLoop();const foreign={name:'foreign'};state.valid.add(foreign);gl.bindFramebuffer(gl.FRAMEBUFFER,foreign);
 module.preMainLoop();assert.equal(state.read,read);assert.equal(state.draw,draw);
});

test('context loss, deletion, replacement, and canvas detachment cannot restore stale framebuffer objects',()=>{
 for(const mode of ['lost','lost-and-restored','deleted','replacement','detached']){
  const {module,state,canvas}=setup();module.postMainLoop();state.calls.length=0;
  if(mode==='lost')state.lost=true;
  if(mode==='lost-and-restored'||mode==='deleted')state.valid.clear();
  if(mode==='replacement')canvas.GLctxObject={GLctx:contextState().gl};
  if(mode==='detached')delete canvas.GLctxObject;
  module.preMainLoop();assert.equal(state.calls.length,0,mode);
  state.lost=false;module.preMainLoop();assert.equal(state.calls.length,0,mode+' must clear pending');
 }
});

test('exit clears the correct module generation before cleanup and the latest host callback',()=>{
 const {config,module,state}=setup();let cleanups=0,exits=0;
 const first=config.getGodotConfig(()=>cleanups++);
 module.postMainLoop();
 const next=config.getModuleConfig('/engine',{});module.preMainLoop();module.postMainLoop();
 assert.equal(state.read,null);assert.equal(state.draw,null);
 // The next generation owns its independent snapshot, even if the previous
 // generation's exit callback arrives late.
 const fresh={name:'new-generation'};state.valid.add(fresh);state.read=fresh;state.draw=fresh;next.postMainLoop();
 first.onExit(0);next.preMainLoop();assert.equal(state.read,fresh);assert.equal(state.draw,fresh);
 config.update({onExit:code=>{assert.equal(code,7);exits++;const n=state.calls.length;next.preMainLoop();next.postMainLoop();assert.equal(state.calls.length,n);}});
 const last=config.getGodotConfig(()=>{cleanups++;const n=state.calls.length;next.preMainLoop();next.postMainLoop();assert.equal(state.calls.length,n);});
 next.postMainLoop();last.onExit(7);assert.equal(cleanups,2);assert.equal(exits,1);
});

test('late hooks from another Engine cannot adopt a replacement context on the reused canvas',()=>{
 const old=setup();old.module.postMainLoop();
 const replacement=contextState();old.canvas.GLctxObject={GLctx:replacement.gl};
 const newer=executeConfig({canvas:old.canvas}).config.getModuleConfig('/second-engine',{});
 newer.postMainLoop();const calls=replacement.state.calls.length;
 old.module.preMainLoop();old.module.postMainLoop();
 assert.equal(replacement.state.calls.length,calls,'retired Engine must not bind the new context');
 newer.preMainLoop();assert.equal(replacement.state.read,replacement.read);assert.equal(replacement.state.draw,replacement.draw);
});

test('WebKit family includes iOS browser brands while desktop Chromium and Firefox have no GL hooks',()=>{
 for(const ua of [safari,'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 CriOS/131.0.0.0 Mobile/15E148 Safari/604.1','Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/132.0 Mobile/15E148','Mozilla/5.0 (iPad) AppleWebKit/605.1.15 EdgiOS/131.0 Mobile/15E148']){
  const {module}=setup({ua});assert.equal(typeof module.preMainLoop,'function',ua);assert.equal(typeof module.postMainLoop,'function',ua);
 }
 const ipad=setup({ua:chrome.replace('X11; Linux x86_64','Macintosh; Intel Mac OS X 10_15'),touch:5});assert.equal(typeof ipad.module.preMainLoop,'function');
 for(const ua of [chrome,chrome.replace('Chrome/','Chromium/'),chrome+' Edg/131.0',chrome+' OPR/116.0','Mozilla/5.0 Gecko/20100101 Firefox/132.0','']){
  const {module,state}=setup({ua});assert.equal(module.preMainLoop,undefined,ua);assert.equal(module.postMainLoop,undefined,ua);assert.equal(state.calls.length,0);assert.equal(state.queries.length,0);
 }
 const unavailable=executeConfig({ua:safari});const missing=unavailable.config.getModuleConfig('/engine',{});missing.preMainLoop();missing.postMainLoop();
});

test('generated source executes the original module loading and Godot callback contracts',async()=>{
 let imported,delivered;const wasm={instantiateStreaming:async(response,imports)=>{assert.deepEqual(await response,{source:'actual response'});imported=imports;return {instance:'instance',module:'module'};}};
 const {config}=executeConfig({wasm});config.update({executable:'game',gdextensionLibs:['extension.wasm']});
 const options=config.getModuleConfig('/assets/game',{source:'actual response'});
 const imports={env:{}};assert.deepEqual(Object.keys(options.instantiateWasm(imports,(...args)=>{delivered=args;})),[]);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(imported,imports);assert.deepEqual(delivered,['instance','module']);
 assert.equal(options.thisProgram,'game');assert.equal(options.locateFile('godot.audio.worklet.js'),'/assets/game.audio.worklet.js');assert.equal(options.locateFile('godot.wasm'),'/assets/game.wasm');
 const events=[];config.update({onExit:code=>events.push('exit:'+code)});config.getGodotConfig(()=>events.push('cleanup')).onExit(0);assert.deepEqual(events,['cleanup','exit:0']);
});

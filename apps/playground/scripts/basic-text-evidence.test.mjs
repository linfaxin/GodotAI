import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {loadBasicTextEngine} from './browser-basic-text-test.mjs';
import {withAcceptanceContext} from './browser-harness.mjs';
import {digest} from './site-evidence.mjs';

const browser={browserType:()=>({name:()=> 'chromium'}),version:()=> 'test'};
async function engineSite(t){
 const directory=await mkdtemp(path.join(tmpdir(),'basic-text-evidence-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const files={'engine.js':Buffer.from('// engine'),'engine.wasm':Buffer.from([0,97,115,109,1,0,0,0]),'engine.audio.worklet.js':Buffer.from('// audio')};
 const asset=name=>({path:name,sha256:digest(files[name]),bytes:files[name].length});
 const release={id:'first',runtimeProfile:'engine-2d-v1',engine:{javascript:asset('engine.js'),wasm:asset('engine.wasm'),worklets:[asset('engine.audio.worklet.js')]}};
 for(const [name,bytes]of Object.entries(files))await writeFile(path.join(directory,name),bytes);
 await writeFile(path.join(directory,'engine-release.json'),JSON.stringify(release));
 return {directory,release,files};
}

test('text acceptance pins loaded engine bytes and rejects directory replacement without CI context',async t=>{
 const {directory,release,files}=await engineSite(t),loaded=await loadBasicTextEngine(directory);
 assert.equal(digest(loaded.javascript),digest(files['engine.js']));
 assert.equal(digest(loaded.wasm),digest(files['engine.wasm']));
 assert.equal(digest(loaded.worklets.get('/engine/godot.audio.worklet.js')),digest(files['engine.audio.worklet.js']));
 const finish=()=>withAcceptanceContext({...loaded.identity,status:'passed'},{directory,browser,contextFile:null});
 assert.equal((await finish()).releaseId,'first');
 await writeFile(path.join(directory,'engine-release.json'),JSON.stringify({...release,id:'replacement'}));
 await assert.rejects(finish(),/E_TEST_RELEASE_ID: releaseId/);
 await writeFile(path.join(directory,'engine-release.json'),JSON.stringify(release));
 await writeFile(path.join(directory,'engine.js'),'// replaced bytes with the same release ID');
 await assert.rejects(finish(),/E_TEST_RELEASE_ID: siteHash/);
 await assert.rejects(loadBasicTextEngine(directory),/AssertionError/);
});

const source=await readFile(new URL('./fixtures/engine-2d/basic-text.cjs',import.meta.url),'utf8');
function renderProbe(visible=()=>true){
 const image={get_width:()=>640,get_height:()=>440,get_pixel:(x,y)=>{const v=visible(x,y)?1:0;return {r:v,g:v};}};
 const G={Node2D:class {get_viewport(){return {get_texture:()=>({get_image:()=>image})};}}};
 const exports={};vm.runInNewContext(source,{exports,console:{log(){}},require:name=>name==='godot'?G:name==='godot-jsb'?{internal:{names:{get_class:n=>n,get_member:n=>n}}}:{}});
 const probe=new exports.default(),box=(x,y,w,h,text)=>({get:key=>({position:{x,y},size:{x:w,y:h},text})[key]});
 Object.assign(probe,{frames:44,checks:{},observations:{},label:box(12,8,580,32),rich:{...box(12,45,580,34),get_parsed_text:()=> '中文 Hello 123'},cjkLabel:box(430,190,190,32,'中文测试'),cjkRich:{...box(430,235,190,34),get_parsed_text:()=> '中文'},wrap:{...box(12,85,260,90),get_line_count:()=>3,get_minimum_size:()=>({y:90})},line:box(12,190,400,36),edit:{get_line_count:()=>2},fail(error){this.error=error.message;}});
 return probe;
}

test('native text checks require pixels in each pure Chinese control, independent of Latin pixels',()=>{
 const allVisible=renderProbe();allVisible._process();assert.equal(allVisible.error,undefined);assert.equal(allVisible.checks.cjkTextPixels,true);
 for(const visible of [(x,y)=>x<430,(x,y)=>x<430||y>=235,(x,y)=>x<430||y<235]){
  const probe=renderProbe(visible);probe._process();
  assert.ok(probe.observations.renderedPixels.label>20);assert.ok(probe.observations.renderedPixels.rich>20);
  assert.match(probe.error,/Pure Chinese plain and rich text must render actual pixels/);
  assert.notEqual(probe.checks.cjkTextPixels,true);
 }
});

test('native text checks reject clipped controls and non-Chinese substitutions',()=>{
 const clipped=renderProbe();clipped.label.get=key=>({position:{x:-100,y:8},size:{x:580,y:32}})[key];clipped._process();assert.match(clipped.error,/inside the viewport/);
 const substituted=renderProbe();substituted.cjkRich.get_parsed_text=()=> 'Hello';substituted._process();assert.match(substituted.error,/only Chinese glyphs/);
});

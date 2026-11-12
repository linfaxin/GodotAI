import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {packProject} from '@godot-js/react-browser/pck';
import {launchTestBrowser,withAcceptanceContext} from './browser-harness.mjs';
import {siteIdentity} from './site-evidence.mjs';
import {observeFeaturePage,validateFeatureNamings} from './browser-2d-features-test.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex'),encode=s=>new TextEncoder().encode(s);
const arg=n=>{const i=process.argv.indexOf(n);return i<0?undefined:process.argv[i+1];},marker='GODOTJS_BASIC_TEXT';

export async function loadBasicTextEngine(directory){
 const {payloads,...identity}=await siteIdentity(directory);
 const load=async relative=>{const bytes=await readFile(path.join(directory,relative));assert.equal(hash(bytes),payloads[relative]?.sha256,'E_TEST_CANDIDATE_DRIFT: '+relative);return bytes;};
 const releaseBytes=await load('engine-release.json');assert.equal(hash(releaseBytes),identity.descriptorHash,'E_TEST_CANDIDATE_DRIFT: descriptorHash');
 const manifest=JSON.parse(releaseBytes);
 const javascript=await load(manifest.engine.javascript.path),servedWasm=await load(manifest.engine.wasm.path);
 assert.equal(hash(javascript),manifest.engine.javascript.sha256);assert.equal(hash(servedWasm),manifest.engine.wasm.sha256);
 const wasm=manifest.engine.wasm.encoding==='gzip'?gunzipSync(servedWasm):servedWasm;assert(WebAssembly.validate(wasm));if(manifest.engine.wasm.decodedSha256)assert.equal(hash(wasm),manifest.engine.wasm.decodedSha256);
 const worklets=new Map();for(const item of manifest.engine.worklets??[]){const bytes=await load(item.path);assert.equal(hash(bytes),item.sha256);worklets.set('/engine/godot'+item.path.slice(item.path.indexOf('.audio')),bytes);}
 return {identity,javascript,wasm,worklets};
}

export async function runBasicTextAcceptance({directory,out,expectFallback=false,namings=['snake','camel']}={}){
 validateFeatureNamings(namings);
 directory=path.resolve(directory);out=path.resolve(out);await mkdir(out,{recursive:true});
 const {identity,javascript,wasm,worklets}=await loadBasicTextEngine(directory);
 const source=await readFile(new URL('./fixtures/engine-2d/basic-text.cjs',import.meta.url)),font=await readFile(new URL('./fixtures/engine-2d/test-cjk.otf',import.meta.url));
 let pack;
 const server=createServer((req,res)=>{
  const n=new URL(req.url,'http://localhost').pathname;
  const route=n==='/'?{type:'text/html',bytes:'<!doctype html><style>html,body{margin:0;background:#05080b}canvas{width:640px;height:440px}</style><canvas id="canvas" tabindex="0" width="640" height="440"></canvas><script src="/engine/godot.js"></script>'}:n==='/fixture.pck'?{type:'application/octet-stream',bytes:pack}:n==='/engine/godot.js'?{type:'application/javascript',bytes:javascript}:n==='/engine/godot.wasm'?{type:'application/wasm',bytes:wasm}:worklets.has(n)?{type:'application/javascript',bytes:worklets.get(n)}:undefined;
  if(!route){res.writeHead(n==='/favicon.ico'?204:404).end();return;}res.writeHead(200,{'content-type':route.type,'cache-control':'no-store'}).end(route.bytes);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 const report={schemaVersion:1,suite:'basic-text',...identity,status:'running',engine:{javascript:hash(javascript),wasm:hash(wasm)},fixture:{source:hash(source),font:hash(font)},expectFallback,inputMethod:'Chromium composition events via CDP; not an OS input-method candidate-window test',cases:[]};
 try{
  browser=await launchTestBrowser({browser:'chromium',headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
  for(const naming of namings){
   const files=new Map([
    ['res://project.godot',encode('config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[display]\nwindow/size/viewport_width=640\nwindow/size/viewport_height=440\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nenvironment/defaults/default_clear_color=Color(0.02,0.03,0.04,1)\n[GodotJS]\nruntime/debugger/debugger_port=0\nruntime/core/camel_case_bindings_enabled='+String(naming==='camel')+'\n')],
    ['res://main.tscn',encode('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://Main.ts" id="1"]\n[node name="TextProbe" type="Node2D"]\nscript=ExtResource("1")\n')],
    ['res://Main.ts',encode('export default class Main {}\n')],['res://.godot/GodotJS/Main.js',source],['res://.godot/global_script_class_cache.cfg',encode('list=Array[Dictionary]([])\n')],['res://text-font.otf',font],['res://text-config.js',encode('module.exports='+JSON.stringify({expectFallback})+';\n')],
   ]);pack=packProject(files).pack;
   const context=await browser.newContext({viewport:{width:640,height:440}}),page=await context.newPage(),observed=observeFeaturePage(page);
   const entry={naming,packSha256:hash(pack),...observed};report.cases.push(entry);
   try{
    await page.addInitScript(()=>{const log=console.log.bind(console);console.log=(...args)=>{const text=args.join(' ');if(text.startsWith('GODOTJS_BASIC_TEXT'))globalThis.__text?.events.push(text);log(...args);};});
    await page.goto('http://127.0.0.1:'+server.address().port+'/');
    await page.evaluate(async()=>{
     window.__text={events:[],exitCode:null};let exited;const exit=new Promise(resolve=>exited=resolve);
     const engine=new Engine({canvas:document.querySelector('canvas'),executable:'/engine/godot',persistentPaths:[],persistentDrops:false,serviceWorker:'',onPrint:(...args)=>window.__text.events.push(args.join(' ')),onPrintError:(...args)=>window.__text.events.push('ERROR '+args.join(' ')),onExit:code=>{window.__text.exitCode=code;exited();}});
     await engine.preloadFile(new Uint8Array(await(await fetch('/fixture.pck')).arrayBuffer()),'/application.pck');await engine.init('/engine/godot');await Promise.race([engine.start({args:['--main-pack','/application.pck','--rendering-method','gl_compatibility']}),exit]);
    });
    await page.waitForFunction(()=>window.__text.events.includes('GODOTJS_BASIC_TEXT_READY')||window.__text.exitCode!==null,null,{timeout:120000});
    assert.equal(await page.evaluate(()=>window.__text.exitCode),null,'Text fixture must reach ready');
    const state=()=>page.evaluate(()=>{const line=window.__text.events.filter(s=>s.startsWith('GODOTJS_BASIC_TEXT_STATE ')).at(-1);return line?JSON.parse(line.slice('GODOTJS_BASIC_TEXT_STATE '.length)):null;});
    const wait=async predicate=>page.waitForFunction(code=>{const line=window.__text.events.filter(s=>s.startsWith('GODOTJS_BASIC_TEXT_STATE ')).at(-1);return line&&Function('s','return ('+code+')(s)')(JSON.parse(line.slice('GODOTJS_BASIC_TEXT_STATE '.length)));},predicate.toString(),{timeout:15000});
    const cdp=await context.newCDPSession(page);
    const compose=async text=>{await page.waitForFunction(()=>document.activeElement?.isContentEditable||['INPUT','TEXTAREA'].includes(document.activeElement?.tagName),null,{timeout:10000});await cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});await cdp.send('Input.insertText',{text});};
    await page.locator('canvas').click({position:{x:55,y:208}});await wait(s=>s.lineFocused);
    await page.keyboard.press('Control+a');await wait(s=>s.lineSelection==='开始');await page.keyboard.press('Backspace');await wait(s=>s.line==='');
    await compose('中文');await page.keyboard.type('123');await wait(s=>s.line==='中文123'&&s.lineCaret===5);
    await page.keyboard.press('Home');await page.keyboard.press('Shift+ArrowRight');await wait(s=>s.lineSelection==='中');await page.keyboard.press('End');
    await page.locator('canvas').click({position:{x:55,y:260}});await wait(s=>s.editFocused);
    await page.keyboard.press('Control+a');await wait(s=>s.editSelection==='中文第一行\nHello 123');await page.keyboard.press('Backspace');await wait(s=>s.edit==='');
    await compose('输入中文');await page.keyboard.press('Enter');await page.keyboard.type('Hello');await wait(s=>s.edit==='输入中文\nHello'&&s.editCaretLine===1&&s.editCaretColumn===5);
    entry.inputState=await state();await page.screenshot({path:path.join(out,naming+'.png')});
    await page.locator('canvas').click({position:{x:530,y:393}});await page.waitForFunction(()=>window.__text.exitCode!==null,null,{timeout:30000});
    Object.assign(entry,await page.evaluate(()=>({events:window.__text.events,exitCode:window.__text.exitCode})));
    const line=entry.events.find(s=>s.startsWith(marker+' '));entry.result=line?JSON.parse(line.slice(marker.length+1)):undefined;
    assert.equal(entry.exitCode,0,JSON.stringify(entry));assert.equal(entry.result?.status,'passed');assert.deepEqual(entry.errors,[]);assert.deepEqual(entry.consoleErrors,[]);
    assert.deepEqual(entry.events.filter(s=>/^ERROR (?:ERROR|SCRIPT ERROR):|WARNING:.*(?:leaked|orphan)|Pages in use exist/.test(s)),[]);
    entry.status='passed';
   }catch(error){entry.status='failed';entry.error=String(error.stack??error);entry.state=await page.evaluate(()=>window.__text).catch(()=>null);await page.screenshot({path:path.join(out,naming+'-failed.png')}).catch(()=>{});throw error;}
   finally{await context.close();await writeFile(path.join(out,'basic-text.json'),JSON.stringify(report,null,2)+'\n');}
  }
  Object.assign(report,await withAcceptanceContext({...report,status:'passed'},{directory,browser}));
 }catch(error){report.status='failed';report.error=String(error.stack??error);throw error;}
 finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(out,'basic-text.json'),JSON.stringify(report,null,2)+'\n');}
 return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{const r=await runBasicTextAcceptance({directory:arg('--site')??process.env.PLAYGROUND_TEST_DIRECTORY,out:arg('--out')??'work/2d-basic-text/acceptance',expectFallback:process.argv.includes('--expect-fallback'),namings:arg('--naming')?[arg('--naming')]:['snake','camel']});console.log(JSON.stringify({status:r.status,cases:r.cases.length,browser:r.browser}));}
 catch(error){console.error(error.stack??error);process.exitCode=1;}
}

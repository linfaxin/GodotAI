import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchBrowser,withAcceptanceContext,defaultTestDirectory} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {defaultProject} from '../src/project-templates.ts';
const directory=defaultTestDirectory();
const release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
const servers=[createStaticServer(directory),createStaticServer(directory)];
for(const server of servers)await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const [editor,preview]=servers.map(server=>'http://127.0.0.1:'+server.address().port);
const browser=await launchBrowser({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
const results=[];
const snapshot=page=>page.evaluate(()=>{const state=globalThis.__playgroundWorkbench?.inspect();return {runtime:state?.project?.runtime,controls:state?.project?.controls,engine:state?.engine,diagnostics:state?.diagnostics,stats:state?.events?.filter(event=>event.type==='stats').at(-1)?.stats,logs:document.querySelector('#logs')?.textContent.slice(-5000)};});
async function selected(page,id='react'){
 await page.goto(editor+'/?project='+id+'&previewOrigin='+encodeURIComponent(preview),{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>globalThis.__playgroundWorkbench?.inspect().ready,null,{timeout:90000});
}
async function imported(page,source,runtime='react'){
 const project=defaultProject(runtime,release.runtimeProfile);project.files[project.entry]=source;
 await page.locator('#import').setInputFiles({name:'demo-regression.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
 await page.waitForFunction(source=>{const state=globalThis.__playgroundWorkbench.inspect();return state.project.files[state.project.entry]===source;},source);
}
async function running(page){
 await page.waitForFunction(()=>{const state=globalThis.__playgroundWorkbench.inspect();if(state.diagnostics.some(d=>d.category==='error'))throw Error(JSON.stringify(state.diagnostics));if(state.engine?.state==='exited'&&document.querySelector('#status').textContent==='运行错误')throw Error(document.querySelector('#logs').textContent);return state.engine?.state==='running';},null,{timeout:120000});
 const handle=await page.locator('#preview iframe').elementHandle(),frame=await handle.contentFrame();await handle.dispose();assert(frame);
 const session=await frame.evaluate(()=>globalThis.__playgroundRuntimeSession);assert.equal(session?.executionBackend,'worker');assert.equal(session.workerState,'running');assert(session.workerId);
}

async function check(name,callback){
 const context=await browser.newContext({viewport:{width:1536,height:1000}}),page=await context.newPage();page.setDefaultTimeout(90000);
 try{await callback(page);results.push({name,status:'passed'});console.error('[demo regression] '+name+' passed');}
 catch(error){results.push({name,status:'failed',error:String(error),snapshot:await snapshot(page).catch(()=>null)});console.error('[demo regression] '+name+' failed');}
 finally{await context.close();}
}
try{
 await check('controls changed while the engine downloads reach the first live demo',async page=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route(/\/engine\/[^/]+\.wasm(?:\.gz)?(?:\?.*)?$/,async route=>{await gate;await route.continue();},{times:1});
  const requested=page.waitForRequest(request=>/\/engine\/[^/]+\.wasm(?:\.gz)?(?:\?.*)?$/.test(request.url()),{timeout:120000});
  try{
   await selected(page,'shader');await requested;
   if(!await page.locator('#settings-section').evaluate(node=>node.open))await page.locator('#settings-section summary').click();
   await page.locator('#control-intensity').fill('2');await page.locator('#control-intensity').dispatchEvent('input');
   assert.equal((await snapshot(page)).controls.intensity,2);release();await running(page);
   await page.waitForFunction(()=>{const event=globalThis.__playgroundWorkbench.inspect().events.filter(event=>event.type==='stats').at(-1);return event?.stats.intensity===2&&event.stats.shaderIntensity===2;},null,{timeout:8000});
  }finally{release();}
 });
 await check('components mounted after the demo receive process, physics and pointer input',async page=>{
  await selected(page);
  await imported(page,`import * as React from 'react';
import {Node} from 'godot';import {EngineNode,useFrame} from '@godot-js/react/engine';
import {withDemo,useDemo,useNodeRef,useProcess,usePhysicsProcess} from '@playground/api';
const hits={process:0,physics:0,clicks:0};
function Late(){const ref=useNodeRef(),demo=useDemo();
 useProcess(ref,()=>{if(demo.input.actions.has('KeyJ'))hits.process++;hits.clicks+=demo.input.clicks.length;demo.stats({ready:true,...hits});});
 usePhysicsProcess(ref,()=>{if(demo.input.pressed.has('KeyJ'))hits.physics++;});
 return <EngineNode ctor={Node} ref={ref}/>;
}
function App(){const [mounted,setMounted]=React.useState(false);useFrame('process',()=>{if(!mounted)setMounted(true);});return mounted?<Late/>:null;}
export default withDemo(App);`);
  await running(page);await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().events.some(event=>event.type==='stats'&&event.stats.ready===true));
  await page.frameLocator('#preview iframe').locator('canvas').click({position:{x:100,y:100}});await page.keyboard.press('j');
  await page.waitForFunction(()=>{const stats=globalThis.__playgroundWorkbench.inspect().events.filter(event=>event.type==='stats').at(-1)?.stats;return stats?.process>0&&stats.physics>0&&stats.clicks>0;},null,{timeout:8000});
  // Pulses must end as well: leaving J released cannot generate another hit.
  const observed=await snapshot(page),first=await page.evaluate(()=>globalThis.__playgroundWorkbench.inspect().events.filter(event=>event.type==='stats').at(-1).frames);
  await page.waitForFunction(first=>globalThis.__playgroundWorkbench.inspect().events.filter(event=>event.type==='stats').at(-1)?.frames>first+12,first);
  const settled=await snapshot(page);assert.deepEqual(settled.stats,observed.stats);
 });
 await check('a native Godot script can import demo helpers with their runtime dependencies',async page=>{
  await selected(page,'native');
  await imported(page,`import {Node2D} from 'godot';import {vec3} from '@playground/api';
export default class Main extends Node2D {_ready(){const value=vec3(1,2,3);if(value.x!==1||value.z!==3)throw Error('Wrong native vector');console.log('NATIVE_DEMO_HELPER_OK');}}`,'godot');
  await running(page);await page.waitForFunction(()=>document.querySelector('#logs').textContent.includes('NATIVE_DEMO_HELPER_OK'),null,{timeout:8000});
  const state=await snapshot(page);assert.equal(state.runtime,'godot');assert.deepEqual(state.diagnostics.filter(d=>d.category==='error'),[]);
 });
 const report=await withAcceptanceContext({status:results.every(result=>result.status==='passed')?'passed':'failed',results}, {directory,browser});
 if(process.env.PLAYGROUND_DEMO_REGRESSIONS_REPORT)await fs.writeFile(process.env.PLAYGROUND_DEMO_REGRESSIONS_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));if(report.status!=='passed')process.exitCode=1;
}finally{await browser.close();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));}

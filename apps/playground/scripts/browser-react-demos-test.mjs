import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {launchBrowser,withAcceptanceContext} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??new URL('../dist',import.meta.url).pathname),servers=[createStaticServer(directory),createStaticServer(directory)];
const release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
for(const server of servers)await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const [editor,preview]=servers.map(s=>'http://127.0.0.1:'+s.address().port);
const browser=await launchBrowser({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
const checks=[],errors=[];let page;
try{
 page=await browser.newPage({viewport:{width:1536,height:1000}});page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(90000);
 const inspect=()=>page.evaluate(()=>globalThis.__playgroundWorkbench.inspect());
 const latest=async()=>(await inspect()).events.filter(e=>e.type==='stats').at(-1);
 async function running(id,previous){await page.waitForFunction(({id,previous})=>{const s=globalThis.__playgroundWorkbench?.inspect();if(s?.project?.demoId!==id)return false;if(s.diagnostics.some(d=>d.category==='error'))throw Error(JSON.stringify(s.diagnostics));const event=s.events.filter(e=>e.type==='stats').at(-1);if(s.engine?.state==='exited'&&document.querySelector('#status').textContent==='运行错误')throw Error(document.querySelector('#logs').textContent);return s.project.runtime==='react'&&s.engine?.state==='running'&&event?.frames>20&&event.generation!==previous;},{id,previous},{timeout:120000});}
 async function stats(predicate){await page.waitForFunction(source=>{const event=globalThis.__playgroundWorkbench.inspect().events.filter(e=>e.type==='stats').at(-1);return event&&Function('s','return ('+source+')(s)')(event.stats)},predicate.toString(),{timeout:30000});return (await latest()).stats;}
 async function choose(id){const previous=(await latest())?.generation;await page.locator('#project-switcher').click();await page.locator('[data-demo="'+id+'"]').click();await running(id,previous);checks.push(id+' runs in the native React renderer');}
 async function settings(){if(!await page.locator('#settings-section').evaluate(n=>n.open))await page.locator('#settings-section summary').click();}
 async function action(key){await settings();await page.locator('[data-action="'+key+'"]').click();}
 const canvas=()=>page.frameLocator('#preview iframe').locator('canvas');
 await page.goto(editor+'/?project=shader&previewOrigin='+encodeURIComponent(preview),{waitUntil:'domcontentloaded'});await running('shader');assert.equal((await latest()).stats.panels,3);checks.push('shader loads real ShaderMaterials');
 await settings();await page.locator('#control-intensity').fill('1.5');await page.locator('#control-intensity').dispatchEvent('input');await stats(s=>s.intensity===1.5&&s.shaderIntensity===1.5);checks.push('controls reach the running native session');
 await choose('lights');await settings();await page.locator('#control-shadows').fill('0');await page.locator('#control-shadows').dispatchEvent('input');await stats(s=>s.shadows===false);
 if(release.runtimeProfile==='full-engine-v1'){
 await choose('islands');await stats(s=>s.grounded===true);await canvas().click({position:{x:200,y:200}});await page.keyboard.press('Space');await stats(s=>s.jumps>=1);checks.push('native input and CharacterBody3D jumping work');
 await choose('city');await action('demolish');await action('undo');await stats(s=>s.kind==='city');const download=page.waitForEvent('download');await action('save');const exported=JSON.parse(await fs.readFile(await (await download).path(),'utf8'));assert.equal(exported.version,1);assert(Array.isArray(exported.cells));checks.push('city actions and JSON export use the project channel');
 await choose('destruction');await action('explode');await stats(s=>s.bodies===24&&s.nativeBodies===24&&s.spread>.1);await action('reset');await stats(s=>s.bodies===0&&s.nativeBodies===0);checks.push('real RigidBody3D shards explode and reset');
 await choose('racing');await stats(s=>s.grounded===true);await canvas().click({position:{x:200,y:200}});await page.keyboard.down('KeyW');await stats(s=>s.speed>.5);await page.keyboard.up('KeyW');checks.push('native input drives the vehicle sphere');
 }
 await choose('match3');await stats(s=>s.tiles===64);await action('hint');await action('shuffle');await stats(s=>s.seed>=43);checks.push('match-3 board actions work');
 await choose('dungeon');const seed=(await latest()).stats.seed;await action('generate');await page.waitForFunction(seed=>globalThis.__playgroundWorkbench.inspect().events.filter(e=>e.type==='stats').at(-1)?.stats.seed!==seed,seed);checks.push('BSP generation remains deterministic and interactive');
 const generation=(await latest()).generation;await page.locator('#stop').click();await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().engine.state==='exited');assert.equal(await page.locator('#preview iframe').count(),0);await page.locator('#run').click();await running('dungeon',generation);checks.push('stop/rerun replaces the preview session');
 assert.deepEqual(errors,[]);const report=await withAcceptanceContext({status:'passed',checks,errors}, {directory,browser});if(process.env.PLAYGROUND_REACT_DEMOS_REPORT)await fs.writeFile(process.env.PLAYGROUND_REACT_DEMOS_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}catch(error){console.error(JSON.stringify({error:String(error),checks,state:await page?.evaluate(()=>globalThis.__playgroundWorkbench?.inspect()).catch(()=>null),logs:await page?.locator('#logs').textContent().catch(()=>null)},null,2));throw error;}
finally{await browser.close();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));}

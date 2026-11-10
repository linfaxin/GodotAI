import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createStaticServer} from './serve.mjs';
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
const server=createStaticServer(directory);await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage(),checks=[],failures=[];
page.setDefaultTimeout(120000);page.on('pageerror',error=>failures.push(String(error)));
const inspect=()=>page.evaluate(()=>window.__playgroundWorkbench.inspect());
async function stop(){const state=await inspect();if(state.engine?.state==='running'){await page.locator('#stop').click();await page.waitForFunction(()=>window.__playgroundWorkbench.inspect().engine.state==='exited');}}
async function imported(source,camel=false){
 await stop();await page.locator('#clear-log').click();
 const project={schemaVersion:2,runtime:'react',demoId:'react',entry:'/src/App.tsx',selected:'/src/App.tsx',mode:'production',controls:{},files:{'/src/App.tsx':source,'/project.godot':`config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n[GodotJS]\nruntime/core/camel_case_bindings_enabled=${camel}\n`}};
 await page.locator('#import').setInputFiles({name:'bridge-regression.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
 await page.waitForFunction(source=>window.__playgroundWorkbench.inspect().project.files['/src/App.tsx']===source,source);
}
async function runningMarker(marker){
 await page.waitForFunction(marker=>{const snapshot=window.__playgroundWorkbench.inspect(),logs=document.querySelector('#logs').textContent,state=snapshot.engine?.state;if(snapshot.diagnostics.some(item=>item.category==='error'))throw Error(JSON.stringify(snapshot.diagnostics));if(state==='exited'&&logs.includes('Error:'))throw Error(logs);return logs.includes(marker)&&state==='running';},marker);
}
const prelude=`import React from 'react';
import {EngineNode,useFrame} from '@godot-js/react/engine';
const G:any=require('godot'),names=require('godot-jsb').internal.names;
const call=(object:any,name:string,...args:any[])=>object[names.get_member(name)](...args);
`;
try{
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.waitForFunction(()=>window.__playgroundWorkbench?.inspect().engine?.state==='running');await stop();
 const specifiers=Object.keys(release.sdk.moduleContract);
 console.error('[bridge] checking SDK subpaths');
 const typeChecks=await page.evaluate(async specifiers=>{
  const worker=new Worker('./compiler.worker.js');let serial=0;
  try{
   const source=specifiers.map((name,index)=>`import * as S${index} from '${name}'; void S${index};`).join('\n')+'\nexport default function App(){return null;}';
   const result=await new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>reject(Error('SDK subpath check timed out')),120000);worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message));};worker.onmessage=e=>{if(e.data.id===id){clearTimeout(timer);resolve(e.data);}};worker.postMessage({id,kind:'compile',runtime:'react',entry:'/src/App.tsx',files:{'/src/App.tsx':source}});});
   return {diagnostics:result.diagnostics,packBytes:result.pack?.byteLength};
  }finally{worker.terminate();}
 },specifiers);
 assert.deepEqual(typeChecks.diagnostics.filter(item=>item.category==='error'),[]);assert(typeChecks.packBytes>0);
 checks.push('every sealed SDK subpath typechecks and compiles through the production worker');
 await imported(specifiers.map((name,index)=>`import * as SDK${index} from '${name}'; void SDK${index};`).join('\n')+'\n'+prelude+`export default function App(){return <EngineNode ctor={G.Label} ref={node=>{if(node)console.log('BRIDGE_SDK_EVALUATED');}}/>;}`);
 await runningMarker('BRIDGE_SDK_EVALUATED');await stop();
 checks.push('all shipped SDK entrypoints evaluate successfully in the real GodotJS engine');
 for(const kind of ['render','commit','frame']){
  console.error('[bridge] checking '+kind+' error');
  const marker='BRIDGE_FAILURE_'+kind.toUpperCase();
  const body=kind==='render'?`throw Error('${marker}');`:kind==='commit'?`React.useLayoutEffect(()=>{throw Error('${marker}');},[]);`:`useFrame('process',()=>{throw Error('${marker}');});`;
  await imported(prelude+`export default function Broken(){${body}return <EngineNode ctor={G.Label}/>;}`);
  await page.waitForFunction(marker=>document.querySelector('#logs').textContent.includes(marker)&&document.querySelector('#status').textContent==='运行错误'&&window.__playgroundWorkbench.inspect().engine?.state==='exited',marker);
  const logs=await page.locator('#logs').textContent();assert(logs.includes(marker));assert(logs.includes('res://src/App.tsx:'+prelude.split('\n').length+':'),'The exact authored source line must reach the editor');
  assert.equal(await page.locator('#preview iframe').count(),0);checks.push(`${kind} failure reports its authored stack and disposes the preview`);
 }
 await imported(prelude+`class Boundary extends React.Component<{children?:React.ReactNode},{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<EngineNode ctor={G.Label} native={{text:'recovered'}} ref={node=>{if(node)console.log('BRIDGE_BOUNDARY_RECOVERED');}}/>:this.props.children;}}
 function Broken():never{throw Error('BRIDGE_CAUGHT');}
 export default function App(){return <Boundary><Broken/></Boundary>;}`);
 await runningMarker('BRIDGE_BOUNDARY_RECOVERED');
 assert.equal((await inspect()).engine.state,'running');assert((await page.locator('#logs').textContent()).includes('BRIDGE_CAUGHT'));await stop();
 checks.push('ErrorBoundary failures retain their rendered fallback and do not terminate the preview');
 console.error('[bridge] ErrorBoundary recovered');
 for(const camel of [false,true]){
  console.error('[bridge] checking '+(camel?'camel':'snake')+' packed values');
  await imported(prelude+`const P=G[names.get_class('PackedVector2Array')],V=G[names.get_class('Vector2')],points=new P();call(points,'push_back',new V(1,2));
 export default function App(){const [tick,setTick]=React.useState(0),ref=React.useRef<any>(null);
 React.useLayoutEffect(()=>{if(tick===0){call(points,'set_indexed',0,new V(9,2));setTick(1);}else if(tick===1){const actual=call(ref.current.points,'get_indexed',0).x;if(actual!==9)throw Error('Packed update stayed at '+actual);console.log('BRIDGE_PACKED_UPDATED 9');setTick(2);}else{if(call(ref.current.points,'size')!==0)throw Error('Packed baseline did not restore');console.log('BRIDGE_PACKED_RESTORED');}},[tick]);
 return <EngineNode ctor={G[names.get_class('Line2D')]} ref={ref} native={tick<2?{points}:{}}/>;}` ,camel);
  await runningMarker('BRIDGE_PACKED_RESTORED');
  assert((await page.locator('#logs').textContent()).includes('BRIDGE_PACKED_UPDATED 9'));assert.equal((await inspect()).engine.state,'running');await stop();
  checks.push(`${camel?'camel':'snake'} packed native values update on mutation and restore their captured baseline`);
 }
 assert.deepEqual(failures,[]);
 const report={status:'passed',releaseId:release.id,checks,sdkSubpaths:specifiers,errors:failures};
 if(process.env.PLAYGROUND_BRIDGE_REPORT){const file=path.resolve(process.env.PLAYGROUND_BRIDGE_REPORT);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}catch(error){console.error(JSON.stringify({error:String(error),checks,state:await inspect().catch(()=>null),logs:await page.locator('#logs').textContent().catch(()=>null)},null,2));throw error;}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));}

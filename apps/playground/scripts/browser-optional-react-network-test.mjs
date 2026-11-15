import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer as createSecureServer} from 'node:https';
import {createServer} from 'node:http';
import {createStaticServer} from './serve.mjs';
import {launchBrowser,withAcceptanceContext} from './browser-harness.mjs';
import {createLocalTestTls,inspectTestSite,localDeploymentEvidence} from './browser-local-tls.mjs';

// Observe real outgoing run messages and real HTTPS requests; data, responses,
// compiler decisions and runtime behavior are never replaced.
const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const siteBytes=await fs.readFile(path.join(directory,'manifest.json')),site=JSON.parse(siteBytes),release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
const prefix=site.publicAssets?'/releases/'+createHash('sha256').update(siteBytes).digest('hex')+'/':'/';
const sdkAssets=new Set([release.sdk.vendor,...Object.values(release.sdk.vendors??{}),...Object.values(release.sdk.runtimeModules)].map(asset=>prefix+asset.path));
const vendorPath=prefix+(release.sdk.vendors?.production??release.sdk.vendor).path;
const timeout=Number(process.env.PLAYGROUND_OPTIONAL_REACT_TIMEOUT??180000),requests=[],errors=[],checks=[];
const tls=process.env.PLAYGROUND_TEST_TLS==='0'?undefined:await createLocalTestTls();
if(tls&&(process.env.BROWSER??'chromium')!=='chromium')throw Error('Pinned local TLS currently requires Chromium; use the explicitly scoped HTTP loopback fixture for other browsers');
let stage='pure-engine',browser,context,page,report={status:'failed',scope:'actual-product-optional-react-network',checks};
function server(origin){
 const files=createStaticServer(directory,{publicImmutable:site.publicAssets===true,urlPrefix:prefix});
 const handler=(request,response)=>{
  const item={origin,stage,path:new URL(request.url,'https://fixture.test').pathname,status:0};requests.push(item);
  response.on('finish',()=>{item.status=response.statusCode;});files.emit('request',request,response);
 };
 return tls?createSecureServer({key:tls.key,cert:tls.cert},handler):createServer(handler);
}
const editor=server('editor'),preview=server('preview');
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)),close=server=>new Promise(resolve=>server.close(resolve));
await Promise.all([listen(editor),listen(preview)]);
const editorOrigin=`${tls?'https':'http'}://127.0.0.1:${editor.address().port}`,previewOrigin=`${tls?'https':'http'}://127.0.0.1:${preview.address().port}`;
const ready=()=>page.waitForFunction(()=>globalThis.__playgroundWorkbench?.inspect().ready&&document.querySelector('#saved')?.textContent==='已自动保存',null,{timeout});
const inspect=()=>page.evaluate(()=>{const state=globalThis.__playgroundWorkbench?.inspect();return state?{ready:state.ready,diagnostics:state.diagnostics,engine:state.engine,releaseContext:state.releaseContext,projectRuntime:state.project.runtime,launch:state.project.engineDocument?.launch}:undefined;});
async function run(document,marker){
 const previous=await page.evaluate(()=>globalThis.__optionalReactArtifacts.length);
 await page.locator('#import').setInputFiles({name:stage+'.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(document))});
 await page.waitForFunction(({previous,marker})=>{
  const state=globalThis.__playgroundWorkbench.inspect();if(state.diagnostics.some(item=>item.category==='error'))throw Error(JSON.stringify(state.diagnostics));
  return state.engine?.state==='running'&&document.querySelector('#logs')?.textContent.includes(marker)&&globalThis.__optionalReactArtifacts.length>previous;
 },{previous,marker},{timeout});
 assert.deepEqual(errors,[]);return page.evaluate(()=>globalThis.__optionalReactArtifacts.at(-1));
}
async function stop(){await page.locator('#stop').click();await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().engine?.state==='exited'&&!document.querySelector('#preview iframe'),null,{timeout});}
const pureProject={schemaVersion:4,runtime:'engine',engineProfile:release.runtimeProfile,launch:{kind:'script',module:'res://src/start.ts'},files:{
 '/src/start.ts':`import {Node,Label,print} from 'godot';
import type {ReactNode} from 'react';
import {EngineRoot} from '@godot-js/react';
import settings from './settings.json';
type ErasedReactTypes=ReactNode|EngineRoot;
export function start({mount}:{mount:Node}){
 const erased:ErasedReactTypes=undefined;void erased;
 console.log('react');
 const label=new Label();label.text=settings.framework;mount.add_child(label);
 if(settings.framework!=='react'||settings.renderer!=='@godot-js/react')throw Error('JSON was not evaluated');
 print('PURE_ENGINE_COLD_NETWORK_OK');
}
`,
 '/src/settings.json':'{"framework":"react","renderer":"@godot-js/react"}',
 '/README.md':'Literal "react", JSON data and erased React types do not select a runtime extension.',
},editor:{selected:'/src/start.ts',mode:'production'}};
const reactProject={schemaVersion:3,runtime:'react',engineProfile:release.runtimeProfile,demoId:'react',entry:'/src/App.tsx',selected:'/src/App.tsx',mode:'production',controls:{},files:{
 '/src/App.tsx':`import React from 'react';
import {EngineNode} from '@godot-js/react';
import {Label,print} from 'godot';
export default function App(){
 React.useLayoutEffect(()=>{print('ACTUAL_REACT_NETWORK_OK');},[]);
 return <EngineNode ctor={Label} native={{text:'Real optional React renderer'}}/>;
}
`,
}};
try{
 const headers=(await inspectTestSite(editorOrigin+prefix+'main.js',tls)).headers;
 assert.match(headers['cache-control'],/immutable/);assert.equal(headers['cross-origin-opener-policy'],'same-origin');assert.equal(headers['cross-origin-embedder-policy'],'require-corp');
 browser=await launchBrowser({headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage',...(tls?['--ignore-certificate-errors-spki-list='+tls.spki]:[])]});
 context=await browser.newContext({viewport:{width:1536,height:1000},serviceWorkers:'block'});
 await context.addInitScript(()=>{
  globalThis.__optionalReactArtifacts=[];
  const nativePost=MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage=function(...args){
   const message=args[0];if(message?.protocolVersion===1&&message.type==='run'&&message.artifact?.manifest)globalThis.__optionalReactArtifacts.push(structuredClone({runId:message.runId,buildKey:message.artifact.buildKey,manifest:message.artifact.manifest}));
   return Reflect.apply(nativePost,this,args);
  };
 });
 page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));page.setDefaultTimeout(timeout);
 await page.goto(editorOrigin+prefix+'?project=native&previewOrigin='+encodeURIComponent(previewOrigin+prefix));await ready();
 assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
 const pure=await run(pureProject,'PURE_ENGINE_COLD_NETWORK_OK'),pureRequests=requests.filter(item=>item.stage==='pure-engine'&&sdkAssets.has(item.path));
 assert.deepEqual(pureRequests,[],'A cold pure engine session must not fetch any declared React runtime/vendor asset');
 assert.equal(pure.manifest.engineId,release.engineId);assert.equal(Object.hasOwn(pure.manifest,'extensionId'),false);assert.equal(pure.manifest.runtime,'engine');
 assert(!Object.keys(pure.manifest.runtimeModules).some(name=>name==='react'||name.startsWith('react/')||name.startsWith('@godot-js/react')));
 assert(!pure.manifest.files.includes('res://.playground/vendor.js'));
 checks.push(`A fresh ${tls?'HTTPS':'HTTP loopback'} browser session runs schema4 native code with React strings, reachable JSON, type-only React and erased value-import types without requesting any declared React vendor/runtime asset`);
 checks.push('The actual outgoing MessagePort run artifact targets the native engineId and omits extensionId, React runtime modules and the vendor file');
 await stop();stage='react';
 const react=await run(reactProject,'ACTUAL_REACT_NETWORK_OK'),reactRequests=requests.filter(item=>item.stage==='react'&&sdkAssets.has(item.path));
 assert(reactRequests.some(item=>item.path===vendorPath&&item.status===200),'The production React vendor must be fetched after actual React usage');
 for(const asset of Object.values(release.sdk.runtimeModules))assert(reactRequests.some(item=>item.path===prefix+asset.path&&item.status===200),'Missing actual React runtime request '+asset.path);
 assert.equal(react.manifest.engineId,release.engineId);assert.equal(react.manifest.extensionId,release.extensionId);assert.equal(react.manifest.runtime,'react');
 assert(react.manifest.runtimeModules.react);assert(react.manifest.runtimeModules['@godot-js/react']);assert(react.manifest.files.includes('res://.playground/vendor.js'));
 checks.push('A subsequent actual React project fetches the matching production vendor/runtime assets, commits a native EngineNode and carries the release extensionId alongside the same engineId');
 await stop();
 report=await withAcceptanceContext({status:'passed',scope:'actual-product-optional-react-network',checks,pageErrors:errors,deployment:localDeploymentEvidence({tls,editorOrigin,previewOrigin,headers}),
  pureEngine:{reactRuntimeRequestCount:pureRequests.length,artifact:{runId:pure.runId,engineId:pure.manifest.engineId,extensionIdAbsent:!Object.hasOwn(pure.manifest,'extensionId'),buildKey:pure.buildKey,runtimeModules:Object.keys(pure.manifest.runtimeModules)}},
  react:{requests:reactRequests,artifact:{runId:react.runId,engineId:react.manifest.engineId,extensionId:react.manifest.extensionId,buildKey:react.buildKey,runtimeModules:Object.keys(react.manifest.runtimeModules)}},
 },{directory,browser});
}catch(error){report={...report,error:String(error),stack:error?.stack,pageErrors:errors,sdkRequests:requests.filter(item=>sdkAssets.has(item.path)),...(page?{observed:await inspect().catch(()=>undefined),logs:await page.locator('#logs').textContent().catch(()=>undefined)}:{})};process.exitCode=1;}
finally{if(process.env.PLAYGROUND_OPTIONAL_REACT_REPORT){const filename=path.resolve(process.env.PLAYGROUND_OPTIONAL_REACT_REPORT);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,JSON.stringify(report,null,2)+'\n');}console.log(JSON.stringify(report,null,2));await context?.close();await browser?.close();await Promise.all([close(editor),close(preview)]);await tls?.dispose();}

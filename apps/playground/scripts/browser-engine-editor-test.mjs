import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {launchBrowser,withAcceptanceContext,defaultTestDirectory} from './browser-harness.mjs';
import {createStaticServer} from './serve.mjs';
import {runtimeTestContext} from './runtime-test-context.mjs';
import {createLocalTestTls} from './browser-local-tls.mjs';

const directory=defaultTestDirectory();
const release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
const profiles={};
for(const naming of ['snake','camel'])profiles[naming]=JSON.parse(await fs.readFile(path.join(directory,release.api.namingProfiles[naming].ir.path),'utf8'));
const siteBytes=await fs.readFile(path.join(directory,'manifest.json')),site=JSON.parse(siteBytes),prefix=site.publicAssets?'/releases/'+createHash('sha256').update(siteBytes).digest('hex')+'/':'/';
const execution=release.execution??release.engine?.execution,tls=execution?.requiresCrossOriginIsolation?await createLocalTestTls():undefined;
const options={urlPrefix:prefix,publicImmutable:site.publicAssets===true,tls},server=createStaticServer(directory,options),preview=createStaticServer(directory,options);
await Promise.all([server,preview].map(value=>new Promise(resolve=>value.listen(0,'127.0.0.1',resolve))));
const scheme=tls?'https':'http',editorRoot=`${scheme}://127.0.0.1:${server.address().port}${prefix}`,previewRoot=`${scheme}://127.0.0.1:${preview.address().port}${prefix}`;
const browser=await launchBrowser({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--disable-dev-shm-usage','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',...(tls?['--ignore-certificate-errors-spki-list='+tls.spki]:[])]});
try{
 const context=await browser.newContext({viewport:{width:1536,height:1000}}),page=await context.newPage();
 // Observe the product's requested Worker tuple through its ordinary Runner.
 // Compiler-only requests cannot invent a native execution configuration.
 await page.goto(editorRoot+'?project=native&previewOrigin='+encodeURIComponent(previewRoot));
 await page.waitForFunction(()=>{const state=globalThis.__playgroundWorkbench?.inspect();if(state?.diagnostics?.some(item=>item.category==='error'))throw Error(JSON.stringify(state.diagnostics));return state?.ready&&state.engine?.state==='running';},null,{timeout:180000});
 await page.locator('#stop').click();await page.waitForFunction(()=>globalThis.__playgroundWorkbench.inspect().engine?.state==='exited'&&!document.querySelector('#preview iframe'),null,{timeout:180000});
 // Only the empty harness document is synthetic. The worker, release, generated
 // declarations and TypeScript language service are the production artifacts.
 await page.route('**/__editor-validation.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Production compiler editor acceptance</title>'}));
 await page.goto(editorRoot+'__editor-validation.html');
 const runtimeContext=await runtimeTestContext(directory,editorRoot);
 const results=await page.evaluate(async releaseContext=>{
  const worker=new Worker('./compiler.worker.js');let serial=0;const pending=new Map();
  worker.onmessage=event=>{const item=pending.get(event.data.id);if(item){pending.delete(event.data.id);clearTimeout(item.timer);event.data.error?item.reject(Error(event.data.error)):item.resolve(event.data);}};
  const request=(kind,source,naming,offset=source.length,byteConfig=false)=>new Promise((resolve,reject)=>{
   const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('Production editor request timed out'));},120000);pending.set(id,{resolve,reject,timer});
   const configuration=`[GodotJS]\nruntime/core/camel_case_bindings_enabled=${naming==='camel'}\n`;
   worker.postMessage({id,kind,runtime:'react',engineProfile:releaseContext.engineProfile,releaseContext,path:'/src/App.tsx',entry:'/src/App.tsx',offset,files:{'/src/App.tsx':source,'/project.godot':byteConfig?[...new TextEncoder().encode(configuration)]:configuration}});
  });
  try{
   const result={};
   for(const naming of ['snake','camel']){
    const completion=await request('completion','import * as G from "godot";\nG.',naming);
    const className=naming==='camel'?'ZipPacker':'ZIPPacker';
    const hoverSource=`import * as G from "godot";\nconst zip=new G.${className}();`;
    const hover=await request('hover',hoverSource,naming,hoverSource.indexOf(className)+2);
    const source='import React from "react"; import {EngineNode} from "@godot-js/react/engine"; import {Label,Timer} from "godot"; export default function App(){return <EngineNode ctor={Label} native={{text:"valid"}}/>;}';
    const positive=await request('check',source,naming);
    const wrongProperty=await request('check',source.replace('text:"valid"','text:123'),naming);
    const readonly=await request('check',source.replace('ctor={Label} native={{text:"valid"}}',`ctor={Timer} native={{${naming==='camel'?'timeLeft':'time_left'}:1}}`),naming);
    const nativeSource=`import {Node2D} from "godot";const node=new Node2D();node.${naming==='camel'?'addChild':'add_child'}(new Node2D());`;
    const bytePositive=await request('check',nativeSource,naming,nativeSource.length,true);
    const wrongSource=nativeSource.replace(naming==='camel'?'addChild':'add_child',naming==='camel'?'add_child':'addChild');
    const byteWrong=await request('check',wrongSource,naming,wrongSource.length,true);
    result[naming]={completion:completion.result,hover:hover.result,positive:positive.diagnostics,wrongProperty:wrongProperty.diagnostics,readonly:readonly.diagnostics,bytePositive:bytePositive.diagnostics,byteWrong:byteWrong.diagnostics};
   }
   return result;
  }finally{worker.terminate();}
 },runtimeContext);
 const report={status:'passed',executionScope:'compiler-worker',releaseId:release.id,nativeConfigurationSource:'observed-product-runner',profiles:{}};
 for(const naming of ['snake','camel']){
  const result=results[naming],names=new Set(result.completion.map(item=>item.name));
  const missing=profiles[naming].classes.filter(cls=>!names.has(cls.publicName)).map(cls=>cls.publicName);
  assert.deepEqual(missing,[],naming+' must complete every actual native class');
  assert(result.completion.length>300,'Full engine completion must not retain the legacy truncation');
  assert(result.hover?.display.includes(naming==='camel'?'ZipPacker':'ZIPPacker'),'Late-alphabet native classes retain hover types');
  assert.deepEqual(result.positive.filter(d=>d.category==='error'),[]);
  assert.deepEqual(result.bytePositive.filter(d=>d.category==='error'),[]);assert(result.byteWrong.some(d=>d.category==='error'));
  for(const [name,diagnostics]of Object.entries({wrongProperty:result.wrongProperty,readonly:result.readonly}))assert(diagnostics.some(d=>d.category==='error'&&d.file==='/src/App.tsx'&&d.line>0&&d.column>0),naming+' '+name+' must be rejected at its source location');
  report.profiles[naming]={classes:profiles[naming].classes.length,completions:result.completion.length,missing,hover:result.hover.display,typedReact:{positive:true,wrongPropertyRejected:true,readonlyRejected:true},byteConfiguration:{positive:true,wrongNamingRejected:true}};
 }
 Object.assign(report,await withAcceptanceContext(report,{directory,browser}));
 if(process.env.PLAYGROUND_EDITOR_REPORT){const output=path.resolve(process.env.PLAYGROUND_EDITOR_REPORT);await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await Promise.all([server,preview].map(value=>new Promise(resolve=>value.close(resolve))));await tls?.dispose();}

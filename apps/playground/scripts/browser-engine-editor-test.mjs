import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createStaticServer} from './serve.mjs';

const directory=path.resolve(process.env.PLAYGROUND_TEST_DIRECTORY??fileURLToPath(new URL('../dist',import.meta.url)));
const release=JSON.parse(await fs.readFile(path.join(directory,'engine-release.json'),'utf8'));
const profiles={};
for(const naming of ['snake','camel'])profiles[naming]=JSON.parse(await fs.readFile(path.join(directory,release.api.namingProfiles[naming].ir.path),'utf8'));
const server=createStaticServer(directory);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const page=await browser.newPage();
 // Only the empty harness document is synthetic. The worker, release, generated
 // declarations and TypeScript language service are the production artifacts.
 await page.route('**/__editor-validation.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Production compiler editor acceptance</title>'}));
 await page.goto(`http://127.0.0.1:${server.address().port}/__editor-validation.html`);
 const results=await page.evaluate(async()=>{
  const worker=new Worker('./compiler.worker.js');let serial=0;const pending=new Map();
  worker.onmessage=event=>{const item=pending.get(event.data.id);if(item){pending.delete(event.data.id);clearTimeout(item.timer);event.data.error?item.reject(Error(event.data.error)):item.resolve(event.data);}};
  const request=(kind,source,naming,offset=source.length,byteConfig=false)=>new Promise((resolve,reject)=>{
   const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('Production editor request timed out'));},120000);pending.set(id,{resolve,reject,timer});
   const configuration=`[GodotJS]\nruntime/core/camel_case_bindings_enabled=${naming==='camel'}\n`;
   worker.postMessage({id,kind,runtime:'react',path:'/src/App.tsx',entry:'/src/App.tsx',offset,files:{'/src/App.tsx':source,'/project.godot':byteConfig?[...new TextEncoder().encode(configuration)]:configuration}});
  });
  try{
   const result={};
   for(const naming of ['snake','camel']){
    const completion=await request('completion','import * as G from "godot";\nG.',naming);
    const className=naming==='camel'?'ZipPacker':'ZIPPacker';
    const hoverSource=`import * as G from "godot";\nconst zip=new G.${className}();`;
    const hover=await request('hover',hoverSource,naming,hoverSource.indexOf(className)+2);
    const source='import React from "react"; import {EngineNode} from "@godot-js/react"; import {Label,Timer} from "godot"; export default function App(){return <EngineNode ctor={Label} native={{text:"valid"}}/>;}';
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
 });
 const report={status:'passed',releaseId:release.id,profiles:{}};
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
 if(process.env.PLAYGROUND_EDITOR_REPORT){const output=path.resolve(process.env.PLAYGROUND_EDITOR_REPORT);await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}

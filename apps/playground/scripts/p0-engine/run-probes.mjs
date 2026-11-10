import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {packProject} from '../../../../scripts/jsb.react-browser/dist/pck.js';
import {createEvidenceReceipt,REQUIRED_SOURCE_PATHS,evidenceRoot} from './evidence-utils.mjs';

const repo=fileURLToPath(new URL('../../../../',import.meta.url));
const output=evidenceRoot();
const sha=value=>createHash('sha256').update(value).digest('hex');
export async function runFixture(fixture,options={}){
 await mkdir(output,{recursive:true});
 const js=options.engineJs??process.env.P0_ENGINE_JS??path.join(repo,'apps/playground/dist/engine/game.js');
 const wasm=options.engineWasm??process.env.P0_ENGINE_WASM??path.join(repo,'apps/playground/dist/engine/game.wasm');
 const [jsBytes,wasmBytes]=await Promise.all([readFile(js),readFile(wasm)]);
 const {pack}=packProject(fixture.files,{maxBytes:256*1024*1024});
 const name=fixture.name??fixture.marker.toLowerCase(),packFile=path.join(output,name+'.pck');
 const role=name.startsWith('api-')?'api':name==='boot-fault'?'bootFault':name.startsWith('boot')?'boot':name==='react-aba'?'aba':name==='web-weak-callback'?'webWeak':'react';
 const evidenceReceipt=process.env.P0_REQUIRE_EVIDENCE==='1'?await createEvidenceReceipt(REQUIRED_SOURCE_PATHS[role],{engineJs:js,engineWasm:wasm,directory:output}):undefined;
 await writeFile(packFile,pack);
 const html='<!doctype html><canvas id="canvas" width="320" height="240" tabindex="0"></canvas><script src="/engine/game.js"></script>';
 const server=createServer(async(req,res)=>{
  try{
   const pathname=new URL(req.url,'http://localhost').pathname;
   if(pathname==='/'){res.writeHead(200,{'content-type':'text/html'}).end(html);return;}
   if(pathname==='/fixture.pck'){res.writeHead(200,{'content-type':'application/octet-stream'}).end(pack);return;}
   if(pathname==='/favicon.ico'){res.writeHead(204).end();return;}
   if(pathname==='/engine/game.js'){res.writeHead(200,{'content-type':'application/javascript'}).end(jsBytes);return;}
   if(pathname==='/engine/game.wasm'){res.writeHead(200,{'content-type':'application/wasm'}).end(wasmBytes);return;}
   if(/^\/engine\/game\.audio\.(?:position\.)?worklet\.js$/.test(pathname)){
    const candidate=path.join(path.dirname(js),path.basename(js).replace(/\.js$/,'')+pathname.slice('/engine/game'.length));
    res.writeHead(200,{'content-type':'application/javascript'}).end(await readFile(candidate));return;
   }
   res.writeHead(404).end('not found');
  }catch(error){res.writeHead(500).end(String(error));}
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium',args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
 const logs=[],errors=[];let evidence;
 try{
  const page=await browser.newPage();page.on('console',message=>{logs.push({level:message.type(),text:message.text()});if(process.env.P0_LIVE_LOGS)console.log(message.text().slice(0,2000));});page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async(extraArgs)=>{
   window.__p0={events:[],attachments:{},exitCode:null};
   window.__p0Attach=(name,value)=>window.__p0.attachments[name]=value;
   const bytes=new Uint8Array(await(await fetch('/fixture.pck')).arrayBuffer());
   let exited;const exit=new Promise(resolve=>exited=resolve);
   const engine=new Engine({canvas:document.querySelector('canvas'),executable:'/engine/game',persistentPaths:[],persistentDrops:false,
    onPrint:(...args)=>window.__p0.events.push(args.join(' ')),onPrintError:(...args)=>window.__p0.events.push('ERROR '+args.join(' ')),
    onExit:code=>{window.__p0.exitCode=code;exited();}});
   window.__p0.engine=engine;
   await engine.preloadFile(bytes,'/application.pck');await engine.init('/engine/game');
   await Promise.race([engine.start({args:['--main-pack','/application.pck','--rendering-method','gl_compatibility',...extraArgs]}),exit]);
  },fixture.engineArgs??[]);
  await page.waitForFunction(()=>window.__p0.exitCode!==null,null,{timeout:options.timeout??120000});
  const native=await page.evaluate(()=>({events:window.__p0.events,attachments:window.__p0.attachments,exitCode:window.__p0.exitCode}));
  const texts=[...native.events,...logs.map(line=>line.text)],line=texts.find(text=>text.includes(fixture.marker+' '));
  let report;if(line)report=JSON.parse(line.slice(line.indexOf(fixture.marker+' ')+fixture.marker.length+1));
  const attachments={};for(const [key,value]of Object.entries(native.attachments)){
   const filename=name+'-'+key.replace(/[^a-z0-9_.-]/gi,'_');await writeFile(path.join(output,filename),typeof value==='string'?value:JSON.stringify(value));attachments[key]=filename;
  }
  const completed=native.exitCode===0&&!!report;
  const status=completed?(report.status&&report.status!=='passed'?'needs-work':'passed'):'failed';
  evidence={name,status,executionStatus:completed?'completed':'failed',...(evidenceReceipt?{evidenceReceipt}:{}),browser:browser.version(),engine:{js:sha(jsBytes),wasm:sha(wasmBytes),jsPath:js,wasmPath:wasm},packBytes:pack.byteLength,packSha256:sha(pack),report,native:{events:native.events,exitCode:native.exitCode},attachments,logs,errors};
  await writeFile(path.join(output,name+'-browser.json'),JSON.stringify(evidence,null,2));
  assert.equal(native.exitCode,0,JSON.stringify(evidence));assert.ok(report,'Missing report '+fixture.marker);assert.deepEqual(errors,[]);
  if(options.screenshot)await page.screenshot({path:path.join(output,name+'.png')});
  return evidence;
 }catch(error){
  if(!evidence)await writeFile(path.join(output,name+'-browser-failure.json'),JSON.stringify({logs,errors,error:String(error)},null,2));throw error;
 }finally{await browser.close();await new Promise(done=>server.close(done));}
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const name=process.argv[2];assert.ok(name,'Expected boot|api|react');
 const fixtureModule=await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)),name+'-fixture.mjs')));
 const create=fixtureModule['create'+name[0].toUpperCase()+name.slice(1)+'Fixture'];
 const result=await runFixture(await create());console.log(JSON.stringify({name,status:result.status,report:result.report,attachments:result.attachments},null,2));if(result.status!=='passed')process.exitCode=2;
}

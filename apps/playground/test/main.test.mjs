import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {browserDriver} from '../../../scripts/test/browser-launch.mjs';

const app=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let browser,server,url;
before(async()=>{
  // Load the actual main.ts and actual project/snapshot modules. Only external
  // release/Worker/preview hosts are controlled, to reproduce replies in transit.
  const bundle=await build({entryPoints:{'main-review':resolve(app,'main.ts'),'monaco-editor-worker':resolve(app,'editor.worker.ts')},outdir:'/virtual-playground',loader:{'.ttf':'dataurl'},define:{'process.env.NODE_ENV':'"production"'},bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'controlled-editor-hosts',setup(api){
    api.onResolve({filter:/\/runner\.js$/},()=>({path:'runner',namespace:'controlled'}));
    api.onResolve({filter:/\/release\.js$/},()=>({path:'release',namespace:'controlled'}));
    api.onLoad({filter:/.*/,namespace:'controlled'},args=>({contents:args.path==='runner'
      ?`export class PreviewRunner { subscribe(){return()=>{}} async stop(){return undefined} async dispose(){await this.stop()} async run(artifact){if(globalThis.previewFailure)throw Error(globalThis.previewFailure);(globalThis.previewStarts??=[]).push({generation:artifact.generation,buildKey:artifact.buildKey});return{state:'running'}} }`
      :`export async function loadRuntimeRelease(){return{release:{id:'a'.repeat(64),certified:false,engine:{godotVersion:'4.6.1',engineTarget:'test-host'},profiles:{'core-ui-v1':{id:'core-ui-v1'}},files:[{kind:'engine-js',path:'godot.js',sha256:'a'.repeat(64)},{kind:'engine-wasm',path:'godot.wasm',sha256:'b'.repeat(64)}]}}}`}));
  }}]});
  const html=(await readFile(resolve(app,'index.html'),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('./main.css','./main-review.css')+'<script type="module" src="/main-review.js"></script>';
  const outputs=new Map(bundle.outputFiles.map(file=>['/'+file.path.split('/').at(-1),file.contents]));
  server=createServer((request,response)=>{
    if(request.url==='/favicon.ico'){response.writeHead(204);response.end();return;}
    if(request.url==='/style.css'){response.setHeader('content-type','text/css');response.end('');return;}
    response.setHeader('content-type',request.url.endsWith('.js')?'application/javascript':request.url.endsWith('.css')?'text/css':'text/html');
    response.end(outputs.get(request.url)??html);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));url=`http://127.0.0.1:${server.address().port}/`;
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK??='1';
  const driver=await browserDriver();browser=await driver.type.launch(driver.launchOptions);
});
after(async()=>{await browser?.close();if(server)await new Promise(done=>server.close(done));});

async function editor(t, options = {}){
  const context=await browser.newContext(),page=await context.newPage();t.after(()=>context.close());
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.addInitScript(()=>{
    const NativeWorker=globalThis.Worker;
    globalThis.Worker=class ControlledCompilerWorker {
      constructor(url,options){if(String(url).includes('monaco-editor-worker.js'))return new NativeWorker(url,options);this.builds=[];globalThis.compilerHost=this;}
      postMessage(message){
        if(message.kind==='init'&&globalThis.initFailure){queueMicrotask(()=>this.onmessage?.({data:{id:message.id,ok:false,error:{message:globalThis.initFailure}}}));return;}
        if(message.kind==='cancel'){this.cancelSent=true;return;}
        if(message.kind==='build'){const index=this.builds.push(message)-1;if(!globalThis.holdAutomaticBuilds)queueMicrotask(()=>this.replyBuild(index,'automatic-'+index));return;}
        if(message.kind==='check'&&globalThis.holdChecks){(this.checks??=[]).push(message);return;}
        queueMicrotask(()=>this.onmessage?.({data:{id:message.id,ok:true,result:message.kind==='check'?{ok:true,diagnostics:[],resolution:{lock:{}}}:undefined}}));
      }
      replyBuild(index,generation){
        const request=this.builds[index];
        this.onmessage?.({data:{id:request.id,ok:true,result:{revision:request.revision,generation,buildKey:(index?'b':'a').repeat(64),pack:new Uint8Array([1,2,3]),manifest:{}}}});
      }
      replyFailure(index,message){const request=this.builds[index];this.onmessage?.({data:{id:request.id,ok:false,error:{message}}});}
      replyCheck(index){const request=this.checks[index];this.onmessage?.({data:{id:request.id,ok:true,result:{ok:true,diagnostics:[],resolution:{lock:{}}}}});}
    };
    globalThis.fetch=async()=>new Response(JSON.stringify({releaseUrl:'./release/release.json',previewUrl:'http://localhost/preview.html',previewLoginUrl:'http://localhost/signin-with-chatgpt'}),{headers:{'content-type':'application/json'}});
  });
  if(options.startup==='pending')await page.addInitScript(()=>{globalThis.holdAutomaticBuilds=true;});
  if(options.initFailure)await page.addInitScript(message=>{globalThis.initFailure=message;},options.initFailure);
  await page.goto(url);await page.waitForFunction(()=>globalThis.playground?.ready||globalThis.playground?.errors?.length);
  if(!options.initFailure){
    await page.waitForFunction(()=>compilerHost.builds.length===1);
    if(options.startup!=='pending'){
      await page.evaluate(()=>compilerHost.replyBuild(0,'initial-demo'));
      await page.waitForFunction(()=>!document.getElementById('run').disabled&&globalThis.previewStarts?.length===1);
      await page.evaluate(async()=>{await playground.stop();compilerHost.builds.length=0;globalThis.previewStarts=[];delete playground.lastArtifact;await playground.check();});
    }
  }
  t.after(()=>assert.deepEqual(errors,[]));return page;
}

test('missing runtime assets display their failure in the preview instead of an empty canvas', async t=>{
  const page=await editor(t,{initFailure:'E_ASSET_HTTP: 404 /release/types/missing.txt'});
  assert.equal(await page.locator('#run').isDisabled(),true);
  assert.equal(await page.locator('#preview-placeholder').isVisible(),true);
  assert.match(await page.locator('#preview-placeholder h1').textContent(),/运行环境加载失败/);
  assert.match(await page.locator('#preview-placeholder p').first().textContent(),/404.*missing\.txt/);
});

test('preview startup rejection restores a visible error and keeps Run available', async t=>{
  const page=await editor(t);
  const result=await page.evaluate(async()=>{
    globalThis.previewFailure='E_RUN_ENDED: Deadline exceeded during handshaking';
    const pending=playground.run().then(()=>'',error=>String(error));compilerHost.replyBuild(0,'failed-generation');return await pending;
  });
  assert.match(result,/handshaking/);
  assert.equal(await page.locator('#preview-placeholder').isVisible(),true);
  assert.match(await page.locator('#preview-placeholder h1').textContent(),/项目未能运行/);
  assert.equal(await page.locator('#preview-login').isVisible(),true);
  assert.match(await page.locator('#preview-login').getAttribute('href'),/\/signin-with-chatgpt$/);
  assert.equal(await page.locator('#run').isDisabled(),false);
});

test('Stop rejects an already queued successful compiler reply before it can start preview',async t=>{
  const page=await editor(t);
  const result=await page.evaluate(async()=>{
    const pending=playground.run().then(()=>({resolved:true}),error=>({error:String(error)}));
    const stopAvailable=!document.getElementById('stop').disabled;
    await playground.stop();compilerHost.replyBuild(0,'cancelled-generation');
    return{outcome:await pending,starts:globalThis.previewStarts??[],cancelSent:compilerHost.cancelSent,lastArtifact:playground.lastArtifact,stopAvailable};
  });
  assert.equal(result.cancelSent,true);assert(result.outcome.error,'Cancelled run must reject');
  assert.equal(result.stopAvailable,true,'Stop is available while compilation is still in flight');
  assert.deepEqual(result.starts,[]);assert.equal(result.lastArtifact,undefined);
});

test('a newer Run supersedes an older reply even when project revision is unchanged',async t=>{
  const page=await editor(t);
  const result=await page.evaluate(async()=>{
    const first=playground.run().then(()=>({resolved:true}),error=>({error:String(error)}));
    const second=playground.run().then(()=>({resolved:true}),error=>({error:String(error)}));
    compilerHost.replyBuild(0,'old-generation');compilerHost.replyBuild(1,'new-generation');
    return{first:await first,second:await second,starts:globalThis.previewStarts??[],lastGeneration:playground.lastArtifact?.generation};
  });
  assert(result.first.error,'Superseded run must reject');assert.equal(result.second.resolved,true);
  assert.deepEqual(result.starts.map(value=>value.generation),['new-generation']);assert.equal(result.lastGeneration,'new-generation');
});

test('actual editor import preserves binary assets and rejects array-like allocation traps',async t=>{
  const page=await editor(t);
  const result=await page.evaluate(async()=>{
    const project=playground.exportProject();project.files['/assets/pixel.png']=[137,80,78,71,13,10,26,10,0,255];project.selected='/assets/pixel.png';
    await playground.importProject(JSON.parse(JSON.stringify(project)));
    const restored=playground.exportProject();
    const invalid=structuredClone(restored);invalid.files['/assets/trap.bin']={length:4294967295};
    let rejection;try{await playground.importProject(invalid);}catch(error){rejection=String(error);}
    return{bytes:restored.files['/assets/pixel.png'],selected:restored.selected,rejection,unchanged:playground.exportProject().files['/assets/trap.bin']===undefined};
  });
  assert.deepEqual(result.bytes,[137,80,78,71,13,10,26,10,0,255]);assert.equal(result.selected,'/assets/pixel.png');
  assert.match(result.rejection,/E_PROJECT_DOCUMENT/);assert.equal(result.unchanged,true);
});

test('file import clears the chooser after success and failure so the same file can be selected again',async t=>{
  const page=await editor(t);
  const project=await page.evaluate(()=>playground.exportProject());
  const file={name:'project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({schemaVersion:1,project}))};
  await page.locator('#import').setInputFiles(file);
  await page.waitForFunction(()=>document.getElementById('toast').textContent==='项目已导入'&&document.getElementById('import').value==='');
  await page.evaluate(path=>playground.setFile(path,'// changed'),project.selected);
  await page.locator('#import').setInputFiles(file);
  await page.waitForFunction(({path,source})=>playground.exportProject().files[path]===source&&document.getElementById('import').value==='',{path:project.selected,source:project.files[project.selected]});
  await page.locator('#import').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{}')});
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('无效项目文件')&&document.getElementById('import').value==='');
});

test('Stop invalidates a coalesced type check before the next check is requested',async t=>{
  const page=await editor(t);
  await page.waitForFunction(()=>document.getElementById('type-status').textContent==='类型检查通过');
  const result=await page.evaluate(async()=>{
    globalThis.holdChecks=true;
    const first=playground.check();await playground.stop();const second=playground.check();
    const count=compilerHost.checks.length;compilerHost.replyCheck(0);compilerHost.replyCheck(1);
    return{count,first:await first,second:await second};
  });
  assert.equal(result.count,2);assert.equal(result.first,undefined);assert.equal(result.second.ok,true);
});

test('rapid project replacement after cursor movement leaves no rejected editor work',async t=>{
  const page=await editor(t);
  await page.evaluate(async()=>{
    const project=playground.exportProject();
    for(let i=0;i<8;i++){playground.editor.focus();playground.editor.setPosition({lineNumber:2,column:4});await playground.importProject(project);}
  });
  await page.waitForTimeout(100);
});

test('opening the page automatically builds once after initialization and recovers from startup failure',async t=>{
  const page=await editor(t,{startup:'pending'});
  const initial=await page.evaluate(()=>({count:compilerHost.builds.length,files:compilerHost.builds[0].files.map(([path])=>path),dependencies:compilerHost.builds[0].config.dependencies}));
  assert.equal(initial.count,1);assert(initial.files.includes('/src/game.ts'));assert(!initial.files.includes('/package.json'));
  assert.equal(initial.dependencies.clsx,'2.1.1');
  await page.evaluate(()=>compilerHost.replyFailure(0,'E_TYPESCRIPT: Demo cannot compile'));
  await page.waitForFunction(()=>!document.getElementById('run').disabled);
  assert.match(await page.locator('#status').textContent(),/运行失败/);
  assert.match(await page.locator('#preview-placeholder h1').textContent(),/项目未能运行/);
  assert.equal(await page.evaluate(()=>compilerHost.builds.length),1);
});

test('Stop cancels the automatic startup build and rejects a late successful reply',async t=>{
  const page=await editor(t,{startup:'pending'});
  await page.evaluate(async()=>{await playground.stop();compilerHost.replyBuild(0,'cancelled-auto-start');});
  await page.waitForFunction(()=>!document.getElementById('run').disabled);
  assert.deepEqual(await page.evaluate(()=>globalThis.previewStarts??[]),[]);
  assert.equal(await page.evaluate(()=>playground.lastArtifact),undefined);
});

test('built-in dependencies are read-only and old manifests disappear without changing source files',async t=>{
  const page=await editor(t);
  await page.evaluate(async()=>{
    const project=playground.exportProject();project.files['/package.json']='{incomplete old manifest';project.selected='/package.json';project.config.dependencies={'left-pad':'1.3.0'};
    await playground.importProject(project);
  });
  assert.equal(await page.locator('#files [data-path="/package.json"]').count(),0);
  assert.equal(await page.locator('#open-package-json').count(),0);
  assert.equal(await page.evaluate(()=>typeof playground.setDependencies),'undefined');
  await page.locator('#dependencies-section > summary').click();assert.equal(await page.locator('#dependencies .dependency-item').count(),4);
  assert.equal(await page.locator('#dependencies input,#dependencies select,#dependencies button').count(),0);
  assert.equal(await page.evaluate(()=>playground.exportProject().config.dependencies.clsx),'2.1.1');
  assert.equal(await page.evaluate(()=>playground.exportProject().selected),'/src/App.tsx');
  await page.click('#new-file');await page.fill('#filename','package.json');await page.locator('#file-form button').click();
  assert.match(await page.locator('#toast').textContent(),/内置依赖/);
  assert.equal(await page.evaluate(()=>'/package.json' in playground.exportProject().files),false);
  const rejected=await page.evaluate(()=>{try{playground.setFile('/package.json','{}')}catch(error){return String(error)}});
  assert.match(rejected,/E_READ_ONLY_DEPENDENCIES/);
});

test('switching examples, reset and import each automatically start the selected project',async t=>{
  const page=await editor(t);
  await page.evaluate(()=>playground.loadExample('state'));
  assert.equal(await page.evaluate(()=>previewStarts.length),1);
  assert(await page.evaluate(()=>compilerHost.builds[0].files.some(([path,source])=>path==='/src/App.tsx'&&source.includes('Theme.Provider'))));
  await page.locator('#examples-menu > summary').click();await page.locator('[data-example="counter"]').click();
  await page.waitForFunction(()=>previewStarts.length===2&&!document.getElementById('run').disabled);
  assert(await page.evaluate(()=>compilerHost.builds[1].files.some(([path])=>path==='/src/Counter.tsx')));
  await page.evaluate(()=>playground.importProject(playground.exportProject()));
  assert.equal(await page.evaluate(()=>previewStarts.length),3);
  await page.locator('#project-menu > summary').click();await page.click('#reset');
  await page.waitForFunction(()=>previewStarts.length===4&&!document.getElementById('run').disabled);
  assert(await page.evaluate(()=>'/src/game.ts' in playground.exportProject().files));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Worker} from 'node:worker_threads';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

// Run the product's minified serialized factory in an actual new Worker realm.
// Node adapts browser message I/O; this does not certify Godot or browser GL.
const entry=fileURLToPath(new URL('../../../packages/engine/src/browser/engine-session.ts',import.meta.url));
const product=(await build({entryPoints:[entry],bundle:true,write:false,format:'cjs',platform:'browser',target:'es2022',minify:true})).outputFiles[0].text;
const module={exports:{}};vm.runInNewContext(product,{module,exports:module.exports,URL,console,setTimeout,clearTimeout});
const source=`const host=globalThis.__godotjsRuntimeHost;
if(!host||host.apiVersion!==1)throw Error('Host must precede the first project statement');
host.assignRole('engine');host.beginNativeEpoch('minified-native-epoch');
const entry=host.openEntry();entry.ready(false);entry.host.emitProjectEvent({type:'minified-project'});entry.close();
host.endNativeEpoch('minified-native-epoch');`;
for(const moduleWorker of [false,true])test('minified '+(moduleWorker?'module':'classic')+' pthread bootstrap contains every dependency',{timeout:10000},async()=>{
 const url='data:text/javascript,'+encodeURIComponent(source);
 const bootstrap=module.exports.runtimeWorkerBootstrap(url,'build-test',7,moduleWorker);
 const worker=new Worker(`const {parentPort}=require('node:worker_threads');
globalThis.postMessage=value=>parentPort.postMessage(value);
globalThis.addEventListener=(type,listener)=>{if(type==='message')parentPort.on('message',data=>listener({data,stopImmediatePropagation(){}}));};
globalThis.importScripts=()=>{${source}};
(async()=>{${bootstrap}})().catch(error=>{throw error;});`,{eval:true});
 try{
  const packets=[];
  await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',packet=>{packets.push(packet);if(packet.type==='summary')resolve();});worker.on('exit',code=>{if(code)reject(Error('Worker exited '+code));});});
  assert(packets.some(packet=>packet.type==='project'&&packet.data.type==='minified-project'));
  const summary=packets.find(packet=>packet.type==='summary').data;
  assert.equal(summary.sealed,true);assert.equal(summary.entries[0].cleanup,'complete');assert.equal(summary.epoch,'minified-native-epoch');
  assert(packets.every(packet=>packet.sessionId==='build-test'&&packet.workerId===7&&packet.__godotjsRuntime===2));
 }finally{await worker.terminate();}
});

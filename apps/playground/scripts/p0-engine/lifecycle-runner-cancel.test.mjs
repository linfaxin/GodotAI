import assert from 'node:assert/strict';
import test from 'node:test';
import {PreviewRunner} from '../../../../scripts/jsb.react-browser/dist/runner.js';

test('synchronous stop from loading-frame event never attaches a retired frame',async()=>{
 const NativeMessageChannel=globalThis.MessageChannel,channels=[];
 globalThis.MessageChannel=class extends NativeMessageChannel{constructor(){super();channels.push(this);}};
 const attached=[];
 const document={location:{origin:'http://editor.test'},createElement(){
  return {setAttribute(){},remove(){const i=attached.indexOf(this);if(i>=0)attached.splice(i,1);},contentWindow:{postMessage(){}}};
 }};
 const container={ownerDocument:document,append(frame){attached.push(frame);}};
 const release={releaseId:'p0-cancel',profile:'native',engineJs:{url:'http://preview.test/godot.js',sha256:'a'.repeat(64)},engineWasm:{url:'http://preview.test/godot.wasm',sha256:'b'.repeat(64)}};
 const runner=new PreviewRunner({container,previewUrl:'http://preview.test/preview.html',release});
 let stopping;
 runner.subscribe(event=>{if(event.type==='state'&&event.state==='loading-frame')stopping=runner.stop();});
 try{
  const result=await runner.run({revision:1,buildKey:'p0',generation:'p0',pack:new Uint8Array([1]),manifest:{generation:'p0'}}).then(value=>({value}),error=>({error:String(error)}));
  const exit=await stopping;
  assert(result.error?.includes('E_RUN_ENDED'));
  assert.equal(exit.reason,'forced-frame-disposal');
  assert.equal(attached.length,0,'A cancelled run must not append its retired iframe after stop has resolved');
 }finally{await runner.dispose();for(const channel of channels){channel.port1.close();channel.port2.close();}globalThis.MessageChannel=NativeMessageChannel;}
});

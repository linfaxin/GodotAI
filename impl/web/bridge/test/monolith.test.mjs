import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../js/jsbb.impl.js',import.meta.url),'utf8');
test('single-thread bootstrap does not require Emscripten pthread globals',()=>{
  const context=vm.createContext({console});
  vm.runInContext(source,context);
  assert.equal(typeof context._jsbb_,'function');
  assert.doesNotThrow(()=>vm.runInContext('_jsbb_.install_pthread_worker_listener_hook()',context));
});
test('pthread bootstrap still installs its direct message listener',()=>{
  const calls=[];
  const context=vm.createContext({console,ENVIRONMENT_IS_PTHREAD:true,addEventListener:(...args)=>calls.push(args)});
  vm.runInContext(source,context);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'message');
});

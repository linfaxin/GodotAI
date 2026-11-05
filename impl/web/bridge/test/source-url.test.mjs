import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../../js/jsbb.impl.js', import.meta.url), 'utf8');
test('native function compilation names its complete wrapper without shifting lines', () => {
  const values = ['res://generated/probe.js', '(function(exports,require,module,__filename,__dirname){throw new Error("named-module");\n})'];
  const context = createContext({ console, values });
  runInContext(source, context);
  runInContext('_jsbb_.wasmop={UTF8ToString:index=>values[index]};globalThis.compiled=undefined;jsbb_Engine.prototype.CompileFunctionSource.call({_stack:{Push(value){globalThis.compiled=value;return 1;}},_throw(error){throw error;}},0,1);', context);
  const stack = runInContext('try{compiled();}catch(error){error.stack;}', context);
  assert.match(stack, /res:\/\/generated\/probe\.js:1:\d+/);
});
test('a filename cannot inject another source directive or executable line', () => {
  const values = ['res://probe.js\nglobalThis.injected=true;//', '(function(){throw new Error("safe");})'];
  const context = createContext({ console, values }); runInContext(source, context);
  runInContext('_jsbb_.wasmop={UTF8ToString:index=>values[index]};jsbb_Engine.prototype.CompileFunctionSource.call({_stack:{Push(){return 1;}},_throw(error){throw error;}},0,1);', context);
  assert.equal(runInContext('globalThis.injected', context), undefined);
});

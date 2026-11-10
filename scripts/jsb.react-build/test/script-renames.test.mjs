import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareScriptRename} from '@godot-js/react-build/script-renames';

test('module renames preserve import forms, extension conventions, comments and plain strings',()=>{
 const source=`import {value} from './value.js';
import type {Value} from './value';
export {value as forwarded} from './value';
export * as values from './value';
import common = require('./value');
const result = require('./value');
const later = import('./value');
const label = "display value";
// import {untouched} from './value';
`;
 const files={'/src/Main.ts':source,'/src/value.ts':'export const value=42;export interface Value {}'};
 const plan=prepareScriptRename(files,'/src/value.ts','/lib/renamed.ts');
 assert.equal(plan.sources['/src/Main.ts'],source);
 const changed=plan.changes['/src/Main.ts'];
 assert.match(changed,/from "\.\.\/lib\/renamed.js"/);
 assert.equal(changed.match(/"\.\.\/lib\/renamed"/g).length,6);
 assert.match(changed,/label = "display value"/);assert.match(changed,/untouched.*'\.\/value'/);
 assert.equal(files['/src/Main.ts'],source);
});
test('unhandled references are rejected before any source is changed',()=>{
 for(const source of [
  '/// <reference path="./types.ts" />\nexport const value=42;',
  'import {ResourceLoader} from "godot";export const value=ResourceLoader.load("res://src/types.ts");',
  'export const path="./types.ts";',
 ]){
  const files={'/src/Main.ts':source,'/src/types.ts':'export const value=42;'},before=structuredClone(files);
  assert.throws(()=>prepareScriptRename(files,'/src/types.ts','/src/renamed.ts'),/E_RENAME_UNSUPPORTED_REFERENCE/);
  assert.deepEqual(files,before);
 }
});
test('moving a script rebases dependencies without rewriting unrelated module spellings',()=>{
 const source=`import data from './settings.json';import {value} from './nested';import {Node} from 'godot';export {value};`;
 const files={'/src/Main.ts':source,'/src/settings.json':'{}','/src/nested/index.ts':'export const value=42;'};
 const changed=prepareScriptRename(files,'/src/Main.ts','/world/Main.ts').changes['/src/Main.ts'];
 assert.match(changed,/"\.\.\/src\/settings.json"/);assert.match(changed,/"\.\.\/src\/nested"/);assert.match(changed,/from 'godot'/);
 assert.throws(()=>prepareScriptRename({...files,'/bad.ts':'export const = ;'},'/src/Main.ts','/world/Main.ts'),/E_RENAME_SYNTAX/);
});

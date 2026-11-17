import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
import {scriptBootstrap} from '../dist/runtime-entry.js';import {bootstrapSource} from '../../../scripts/jsb.react-build/dist/bootstrap.js';
import {nativeModuleSource} from '../dist/native-module-exports.js';

test('ordinary and component bootstrap bytes are identical in Node and a real minified browser compiler bundle',async()=>{
 const bundle=await build({stdin:{contents:'export {scriptBootstrap} from "@godot-js/project-tools/runtime-entry";export {nativeModuleSource} from "@godot-js/project-tools/native-module-exports";export {bootstrapSource} from '+JSON.stringify(fileURLToPath(new URL('../../../scripts/jsb.react-build/dist/bootstrap.js',import.meta.url)))+';',resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,platform:'browser',format:'cjs',target:'es2022',minify:true});
 const module={exports:{}};vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports});
 assert.equal(module.exports.scriptBootstrap('res://start.js','start'),scriptBootstrap('res://start.js','start'));
 assert.equal(module.exports.nativeModuleSource(),nativeModuleSource());
 assert.equal(module.exports.bootstrapSource('app','generated/react'),bootstrapSource('app','generated/react'));
});

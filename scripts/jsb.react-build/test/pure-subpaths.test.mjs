import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {parseSceneText} from '@godot-js/react-build/scene-text';
import {bootstrapSource} from '@godot-js/react-build/bootstrap';
import {CANONICAL_IMPORTS} from '@godot-js/react-build/imports';
import {bundleClosedModulesWith} from '@godot-js/react-build/module-loading';

test('pure public subpaths retain their APIs without loading the project compiler',async()=>{
 assert.equal(parseSceneText('[gd_scene format=3]\n[node name="Main" type="Node"]\n')[1].name,'node');
 assert.match(bootstrapSource('main','generated/react'),/class ReactApplication/);
 assert.equal(CANONICAL_IMPORTS.react,'React');assert.equal(typeof bundleClosedModulesWith,'function');
 const result=await build({stdin:{contents:`export {parseSceneText} from '@godot-js/react-build/scene-text';
export {bootstrapSource} from '@godot-js/react-build/bootstrap';
export {CANONICAL_IMPORTS} from '@godot-js/react-build/imports';
export {bundleClosedModulesWith} from '@godot-js/react-build/module-loading';
export {readProjectStringSetting,writeProjectStringSetting} from '@godot-js/react-build/project-settings';
export {moduleCandidates,projectModulePath,emittedModulePath} from '@godot-js/react-build/project-modules';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'neutral',format:'esm',target:'es2022',metafile:true});
 const inputs=Object.keys(result.metafile.inputs);
 assert.ok(!inputs.some(name=>/typescript|core\/engine-project|resource-uids|react-browser|apps\//.test(name)),inputs.join('\n'));
 assert.ok(!Object.values(result.metafile.outputs).some(output=>output.imports.some(item=>item.path==='typescript')));
});

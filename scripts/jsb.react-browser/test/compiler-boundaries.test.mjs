import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

test('asset parsing and injected compiler-core do not import the TypeScript runtime',async()=>{
 for(const [module,symbol] of [['assets','parseSceneText'],['scene-text','parseSceneText'],['compiler-core','createBrowserCompilerCore']]){
  const result=await build({stdin:{contents:`export {${symbol}} from '@godot-js/react-browser/${module}';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'neutral',mainFields:['module','main'],format:'esm',target:'es2022',metafile:true});
  const inputs=Object.keys(result.metafile.inputs);
  assert.ok(!inputs.some(name=>/typescript|core\/engine-project|resource-uids/.test(name)),module+'\n'+inputs.join('\n'));
  assert.ok(!Object.values(result.metafile.outputs).some(output=>output.imports.some(item=>item.path==='typescript')));
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {repositorySourcePath} from './seal-site-acceptance.mjs';

test('site source maps resolve package sources and relocatable app sources inside the repository',()=>{
 assert.equal(repositorySourcePath('../../../packages/engine/src/runtime-host.ts'),'packages/engine/src/runtime-host.ts');
 assert.equal(repositorySourcePath('../../../../scripts/jsb.react/src/engine.ts'),'scripts/jsb.react/src/engine.ts');
 assert.equal(repositorySourcePath('../src/main.ts'),'apps/playground/src/main.ts');
 assert.equal(repositorySourcePath('./preview.ts'),'apps/playground/preview.ts');
 for(const path of ['/etc/passwd','file:///etc/passwd','C:/repo/file.ts','packages/engine/../../private','packages//engine.ts','src/../private','packages/engine/src/./host.ts','packages\\engine\\host.ts','packages/engine/\u0000host.ts'])assert.throws(()=>repositorySourcePath(path),/E_SITE_SOURCE_PATH/);
});

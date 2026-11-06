import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot, buildKey } from '../dist/snapshot.js';
import { packProject } from '../dist/pck.js';
const config = { schemaVersion: 1, entry: 'src/App.tsx', dependencies: {}, mode: 'production', profileId: 'core-ui-v1' };
test('source snapshot owns bytes and isolates all public reads', async () => {
  const input = new Uint8Array([1, 2, 3]);
  const snapshot = await createSnapshot({ revision: 1, files: { 'src/App.tsx': input }, config });
  input.fill(9); snapshot.files.get('/src/App.tsx').fill(7);
  assert.throws(() => { snapshot.files[Symbol.iterator] = function* () { yield ['/src/App.tsx', new Uint8Array([9])]; }; }, TypeError);
  assert.throws(() => { snapshot.files.get = () => new Uint8Array([9]); }, TypeError);
  assert.deepEqual([...snapshot.files.get('/src/App.tsx')], [1, 2, 3]);
  const same = await createSnapshot({ revision: 2, files: { 'src/App.tsx': new Uint8Array([1, 2, 3]) }, config });
  assert.equal(snapshot.sourceHash, same.sourceHash);
  const reused = await createSnapshot({ revision: 3, files: snapshot.files, config: snapshot.config });
  assert.equal(reused.sourceHash, snapshot.sourceHash);
  for (const path of ['../x', 'src/../x', 'src\\x', '.godot/a', 'project.godot', 'src/A?x'])
    await assert.rejects(createSnapshot({ revision: 1, files: { [path]: '' }, config }), /E_PROJECT_PATH/);
});
test('untyped snapshot values cannot allocate before byte validation', async () => {
  await assert.rejects(createSnapshot({ revision: 1, files: { 'src/App.tsx': { length: 4294967295 } }, config }), /E_PROJECT_FILE/);
});
test('snapshot deeply owns config and lock and rejects non-JSON identity inputs', async () => {
  const inputConfig = { ...config, props: { nested: { value: 1 } } }, lock = { files: ['a'] };
  const snapshot = await createSnapshot({ revision: 1, files: { 'src/App.tsx': '' }, config: inputConfig, lock });
  inputConfig.props.nested.value = 2; lock.files.push('b');
  assert.equal(snapshot.config.props.nested.value, 1);
  assert.deepEqual(snapshot.lock.files, ['a']);
  assert.throws(() => { snapshot.config.props.nested.value = 3; }, TypeError);
  await assert.rejects(createSnapshot({ revision: 1, files: snapshot.files, config: { ...config, props: { value: NaN } } }), /E_PROJECT_CONFIG/);
});
test('build identity includes dependency/type/release inputs', async () => {
  const a = { sourceHash: 'a', resolutionHash: 'b', runtimeRelease: 'r', sdkMode: 'production', profileId: 'core-ui-v1', compilerVersion: 'v', typescriptVersion: '6', typeOptionsHash: 't' };
  for (const key of Object.keys(a)) assert.notEqual(await buildKey(a), await buildKey({ ...a, [key]: a[key] + 'x' }));
});
test('multi-entry primary selection is explicit and cannot depend on key sorting', async () => {
  const files = { '/src/A.tsx': '', '/src/Z.tsx': '' };
  const entries = { z: { module: '/src/Z.tsx' }, a: { module: '/src/A.tsx' } };
  const snapshot = await createSnapshot({ revision: 1, files, config: { ...config, entry: '/src/Z.tsx', entries } });
  assert.equal(snapshot.config.entry, '/src/Z.tsx');
  for (const entries of [{}, { a: { module: '/src/A.tsx' } }, { a: { module: '/src/Z.tsx' }, b: { module: '/src/Z.tsx' } }])
    await assert.rejects(createSnapshot({ revision: 1, files, config: { ...config, entry: '/src/Z.tsx', entries } }), /E_ENTRY/);
});
test('binary PCK preserves arbitrary bytes, Unicode paths and empty files', () => {
  const { pack, index } = packProject(new Map([['res://中文/图.bin', new Uint8Array([0, 255, 128, 1])], ['res://empty', new Uint8Array()]]));
  assert.equal(new DataView(pack.buffer).getUint32(0, true), 0x43504447);
  const entry = index['res://中文/图.bin'];
  assert.deepEqual([...pack.slice(entry.offset, entry.offset + entry.size)], [0, 255, 128, 1]);
  assert.equal(index['res://empty'].size, 0);
  assert.throws(() => packProject(new Map([['A', new Uint8Array()], ['a', new Uint8Array()]])), /E_PCK_PATH/);
  assert.throws(() => packProject(new Map([['x', new Uint8Array(50)]]), { maxBytes: 1 }), /E_PCK_BUDGET/);
});

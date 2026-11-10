import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEditorProject } from '../dist/project-document.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { game2DProject } from '../../test/browser-game-2d.mjs';
const config = { schemaVersion: 1, entry: 'src/App.tsx', dependencies: {}, mode: 'production', profileId: 'core-ui-v1' };
const project = files => ({ config, files, selected: '__proto__' });
test('imports normalize paths and own binary bytes and selection', async () => {
  const input = project({ 'src/App.tsx': '', 'assets/pixel.png': [0, 255, 128] });
  const result = await parseEditorProject(input);
  assert.equal(result.selected, '/src/App.tsx');
  assert.equal(result.config.entry, '/src/App.tsx');
  input.files['assets/pixel.png'][0] = 42;
  assert.deepEqual(result.files['/assets/pixel.png'], [0, 255, 128]);
});
test('imports reject array-like allocation attacks and invalid bytes', async () => {
  for (const bytes of [{ length: 4294967295 }, [1.5], [256], [-1], ['0'], [null]])
    await assert.rejects(parseEditorProject(project({ 'src/App.tsx': '', 'assets/pixel': bytes })), /E_PROJECT_DOCUMENT/);
});
test('imports enforce byte/file budgets, normalized collisions and reserved namespaces', async () => {
  await assert.rejects(parseEditorProject(project({ 'src/App.tsx': '中文' }), { maxBytes: 5 }), /E_PROJECT_DOCUMENT/);
  await assert.rejects(parseEditorProject(project({ 'src/App.tsx': '', '/src/App.tsx': '' })), /E_PROJECT_DOCUMENT/);
  await assert.rejects(parseEditorProject(project({ 'src/App.tsx': '', 'node_modules/spoof': '' })), /E_PROJECT_PATH/);
  await assert.rejects(parseEditorProject(project({ 'src/App.tsx': '', '/x': '' }), { maxFiles: 1 }), /E_PROJECT_DOCUMENT/);
});
test('the real combined integration helper produces importable, JSON-roundtrippable projects without caller config', async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const art = JSON.parse(await readFile(new URL('../../../apps/playground/examples/art.json', import.meta.url), 'utf8'));
  const images = ['rover', 'ship'].map(name => Array.from(Buffer.from(art[name], 'base64')));
  const page = { evaluate: async () => images };
  for (const mode of ['production', 'development']) {
    // parseEditorProject runs the same immutable snapshot/config validation used
    // by Playground importProject, so missing entry/schema fields fail here.
    const value = await game2DProject(page, repo, mode);
    const imported = await parseEditorProject(JSON.parse(JSON.stringify(value)));
    assert.equal(imported.config.mode, mode);
    assert.equal(imported.config.profileId, 'game-2d-v1');
    assert.equal(imported.selected, imported.config.entry);
    assert.match(imported.files[imported.config.entry], /GAME2D_NATIVE_COMPOSITION_OK/);
    for (const asset of Object.values(imported.config.assets)) assert(imported.files[asset.source], asset.source);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const source = await readFile(new URL('../examples/station/game.ts.txt', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { update, INITIAL_STATE, MISSION_TARGET } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('outpost upgrades consume inventory while preserving cumulative mission progress', () => {
  let state = { ...INITIAL_STATE };
  assert.deepEqual(update(state, { type: 'drone' }), state, 'Cannot purchase unaffordable upgrades');
  for (let n = 0; n < 8; n++) state = update(state, { type: 'mine' });
  state = update(state, { type: 'drill' });
  assert.deepEqual({ ore: state.ore, mined: state.mined, drill: state.drill }, { ore: 0, mined: 8, drill: 2 });
  for (let n = 0; n < 6; n++) state = update(state, { type: 'mine' });
  state = update(state, { type: 'drone' });
  state = update(state, { type: 'tick' });
  assert.deepEqual({ ore: state.ore, mined: state.mined, drones: state.drones }, { ore: 1, mined: 21, drones: 1 });
});

test('outpost pause freezes both actions and automation, with a complete fresh restart', () => {
  const paused = update({ ...INITIAL_STATE, ore: 30, mined: 30, drones: 2 }, { type: 'pause' });
  for (const type of ['mine', 'tick', 'drill', 'drone']) assert.deepEqual(update(paused, { type }), paused);
  const resumed = update(paused, { type: 'pause' });
  assert.equal(update(resumed, { type: 'tick' }).mined, 32);
  assert.deepEqual(update(resumed, { type: 'reset' }), INITIAL_STATE);
});

test('outpost completion clamps progress and prevents further mining or spending', () => {
  const complete = update({ ...INITIAL_STATE, ore: 50, mined: MISSION_TARGET - 1, drill: 10 }, { type: 'mine' });
  assert.equal(complete.mined, MISSION_TARGET); assert.equal(complete.ore, 51);
  for (const type of ['mine', 'tick', 'drill', 'drone']) assert.deepEqual(update(complete, { type }), complete);
});

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../examples.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
const { createExample } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));

test('the unified example has a closed resource set and fits the existing URL share limits', () => {
  const project = createExample('game2d');
  assert.equal(project.config.profileId, 'game-2d-v1');
  for (const asset of Object.values(project.config.assets)) assert(Object.hasOwn(project.files, asset.source));
  assert.deepEqual(Object.keys(project.config.assets).sort(), ['actor', 'crystal', 'floor', 'rover', 'ship', 'wall']);
  const serialized = Buffer.from(JSON.stringify({ schemaVersion: 1, project }));
  assert(serialized.byteLength <= 1024 * 1024);
  assert(gzipSync(serialized).toString('base64url').length <= 24000);
});

test('adding the unified example leaves existing example profiles and default unchanged', () => {
  assert.equal(createExample().config.profileId, 'ui-media-v1');
  assert.equal(createExample('media').config.profileId, 'ui-media-v1');
  assert.equal(createExample('physics').config.profileId, 'behavior-physics-v1');
  assert.equal(createExample('counter').config.profileId, 'core-ui-v1');
  assert.deepEqual(createExample(), createExample('starter'));
  const first = createExample('game2d');first.files['/assets/rover.png'][0] = 0;
  assert.equal(createExample('game2d').files['/assets/rover.png'][0], 137);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

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

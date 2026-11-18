import test from 'node:test';
import assert from 'node:assert/strict';
import {ResourceConverterRegistry, createBrowserResourceConverters, BINARY_RESOURCE_TARGET_ABI} from '../dist/resource-converters.js';
import {resourceTargetForEngine} from '../dist/resource-formats.js';

const target = {resourceAbi: BINARY_RESOURCE_TARGET_ABI, features: {engineId: 'e'.repeat(64)}};
const textTarget = {...target, resourceAbi: 'godot-4-text-resource-v1'};
function wav() {
  const bytes = new Uint8Array(46), view = new DataView(bytes.buffer), encode = new TextEncoder();
  bytes.set(encode.encode('RIFF')); view.setUint32(4, 38, true); bytes.set(encode.encode('WAVEfmt '), 8); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true); bytes.set(encode.encode('data'), 36); view.setUint32(40, 2, true); return bytes;
}
test('descriptions and execution select exactly the same binary or legacy WAV recipe', async () => {
  const registry = createBrowserResourceConverters();
  for (const selected of [target, textTarget]) {
    const description = registry.describe(selected).find(item => item.id === 'godotjs/wav-pcm');
    const result = await registry.run([{resource: 'res://tone.wav', converter: description.id}], new Map([['res://tone.wav', wav()]]), selected);
    assert.equal(description.version, result.receipts[0].converter.version); assert.deepEqual(description.output, result.receipts[0].converter.output);
    assert.equal(description.target.status, 'supported'); assert.equal(description.parameters.status, 'available');
    assert(Object.isFrozen(description)); assert(Object.isFrozen(description.extensions));
  }
  assert.equal(registry.describe(textTarget).find(item => item.id === 'godotjs/png-ctex').target.status, 'unsupported');
  assert.deepEqual(registry.describe(target).find(item => item.id === 'godotjs/png-ctex').parameters.options, {mipmaps: [false]});
});

test('custom producers never acquire built-in facts from their name or execute callbacks during describe', () => {
  let calls = 0;
  const producer = {id: 'godotjs/png-ctex', version: 'custom', extensions: ['png'], parameters() {calls++; throw Error('parameters called');}, preflight() {calls++; throw Error('preflight called');}, convert() {calls++; throw Error('convert called');}};
  const registry = new ResourceConverterRegistry().register(producer); producer.version = 'changed'; producer.extensions.push('jpeg');
  const [description] = registry.describe(target);
  assert.equal(calls, 0); assert.equal(description.version, 'custom'); assert.deepEqual(description.extensions, ['png']);
  assert.equal(description.target.status, 'unknown'); assert.equal(description.parameters.status, 'unknown');
});

test('resource target comes from a supported actual engine version and identity', () => {
  assert.equal(resourceTargetForEngine('4.6.1.stable.custom_build', 'e'.repeat(64)).status, 'available');
  for (const version of ['4.6.10', '4.6.3', 'unknown', undefined]) assert.equal(resourceTargetForEngine(version, 'e'.repeat(64)).status, 'unknown');
  assert.equal(resourceTargetForEngine('4.6.1', undefined).status, 'unknown');
});

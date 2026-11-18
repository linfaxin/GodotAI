import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {verifyAndDecodeAsset} from '../dist/release-assets.js';
import {fetchVerifiedAsset} from '../dist/browser/verified-loader.js';

const encode = value => new TextEncoder().encode(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const limits = {maxStoredBytes: 1024, maxDecodedBytes: 1024};
const integrity = bytes => ({sha256: sha(bytes), bytes: bytes.length});

test('decoder captures exact views, metadata, options and the original signal before hashing', async () => {
  const backing = encode('prefix:payload:suffix'), bytes = backing.subarray(7, 14), original = bytes.slice();
  const asset = integrity(bytes), controller = new AbortController(), options = {...limits, signal: controller.signal};
  const pending = verifyAndDecodeAsset(bytes, asset, options);
  backing.fill(0); asset.sha256 = '0'.repeat(64); asset.bytes = 0; options.maxStoredBytes = 1;
  assert.deepEqual(await pending, original);
  const late = new AbortController(), reason = Error('original signal cancelled');
  const init = {...limits, signal: late.signal}, check = verifyAndDecodeAsset(original, integrity(original), init);
  init.signal = new AbortController().signal; late.abort(reason);
  await assert.rejects(check, error => error === reason);
});

test('gzip verifies stored and decoded bytes independently and bounds expansion', async () => {
  const decoded = encode('hello gzip '.repeat(30)), stored = new Uint8Array(gzipSync(decoded));
  const asset = {...integrity(stored), encoding: 'gzip', decodedBytes: decoded.length, decodedSha256: sha(decoded)};
  assert.deepEqual(await verifyAndDecodeAsset(stored, asset, limits), decoded);
  await assert.rejects(verifyAndDecodeAsset(decoded, asset, limits), /E_ASSET_LENGTH/);
  await assert.rejects(verifyAndDecodeAsset(stored, {...asset, sha256: '0'.repeat(64)}, limits), /E_ASSET_HASH/);
  await assert.rejects(verifyAndDecodeAsset(stored, {...asset, decodedSha256: '0'.repeat(64)}, limits), /E_ASSET_DECODED_HASH/);
  await assert.rejects(verifyAndDecodeAsset(stored, asset, {...limits, maxDecodedBytes: 20}), /E_ASSET_DECODED_SIZE/);
  const {decodedBytes: _size, ...streamed} = asset;
  await assert.rejects(verifyAndDecodeAsset(stored, streamed, {...limits, maxDecodedBytes: 20}), /E_ASSET_DECODED_SIZE/);
  await assert.rejects(verifyAndDecodeAsset(stored, {...asset, decodedBytes: decoded.length + 1}, limits), /E_ASSET_DECODED_LENGTH/);
  await assert.rejects(verifyAndDecodeAsset(stored, {...asset, maxDecodedBytes: 20}, limits), /E_ASSET_DECODED_SIZE/);
});

test('URL loader compatibility keeps optional stored length and delegates verification', async () => {
  const decoded = encode('compatible'), stored = new Uint8Array(gzipSync(decoded));
  const asset = {url: 'https://assets.example/game.js.gz', sha256: sha(stored), encoding: 'gzip', decodedSha256: sha(decoded), decodedBytes: decoded.length};
  let release, entered;
  const arrived = new Promise(resolve => entered = resolve), response = new Promise(resolve => release = resolve);
  const controller = new AbortController(), options = {signal: controller.signal, fetch: async (url, init) => {entered({url, init}); return response;}};
  const pending = fetchVerifiedAsset(asset, options), observed = await arrived;
  asset.sha256 = '0'.repeat(64); asset.url = 'https://wrong.example/'; options.signal = new AbortController().signal;
  assert.equal(observed.init.signal, controller.signal); assert.equal(observed.url, 'https://assets.example/game.js.gz');
  release(new Response(stored));
  assert.deepEqual(await pending, decoded);
  assert.deepEqual(await fetchVerifiedAsset({url: 'https://assets.example/empty', sha256: sha(new Uint8Array())}, {fetch: async () => new Response(new Uint8Array())}), new Uint8Array());
  await assert.rejects(fetchVerifiedAsset({url: 'https://assets.example/file', sha256: sha(decoded), bytes: decoded.length + 1}, {fetch: async () => new Response(decoded)}), /E_ASSET_LENGTH/);
});

test('invalid metadata and quotas fail without changing the existing asset errors', async () => {
  const bytes = encode('asset');
  for (const limit of [0, -1, NaN, 1.5]) await assert.rejects(verifyAndDecodeAsset(bytes, integrity(bytes), {...limits, maxStoredBytes: limit}), /E_RELEASE_ASSET_SIZE/);
  await assert.rejects(verifyAndDecodeAsset(bytes, integrity(bytes), {...limits, maxStoredBytes: 1}), /E_ASSET_SIZE/);
  await assert.rejects(verifyAndDecodeAsset(bytes, {...integrity(bytes), encoding: 'gzip'}, limits), /E_RELEASE_DECODED_DIGEST/);
  await assert.rejects(verifyAndDecodeAsset(bytes, {...integrity(bytes), decodedBytes: 1}, limits), /E_RELEASE_ENCODING/);
});

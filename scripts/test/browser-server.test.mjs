import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { serveBrowserSite } from './browser-server.mjs';

test('browser fixture is static, non-isolated, correctly typed and cannot escape its root', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'browser-server-'));
  const outside = await mkdtemp(resolve(tmpdir(), 'browser-server-private-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(resolve(root, 'index.html'), '<title>fixture</title>');
  await writeFile(resolve(root, 'engine.wasm'), Buffer.from([0, 97, 115, 109]));
  await writeFile(resolve(outside, 'private'), 'do not serve');
  await symlink(resolve(outside, 'private'), resolve(root, 'escape'));
  const server = await serveBrowserSite({ root, csp: "default-src 'self'", host: '127.0.0.1' });
  t.after(() => server.close());
  const index = await fetch(server.url);
  assert.equal(index.status, 200); assert.match(await index.text(), /fixture/);
  assert.equal(index.headers.get('cross-origin-opener-policy'), null);
  assert.equal(index.headers.get('cross-origin-embedder-policy'), null);
  assert.equal(index.headers.get('content-security-policy'), "default-src 'self'");
  assert.equal(index.headers.get('access-control-allow-origin'), '*');
  const wasm = await fetch(server.url + '/engine.wasm', { method: 'HEAD' });
  assert.equal(wasm.headers.get('content-type'), 'application/wasm'); assert.equal((await wasm.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(server.url + '/api/save', { method: 'POST', body: 'write' })).status, 405);
  assert.equal((await fetch(server.url + '/escape')).status, 403);
  assert.equal((await fetch(server.url + '/missing')).status, 404);
  await assert.rejects(serveBrowserSite({ root, headers: { 'Cross-Origin-Opener-Policy': 'same-origin' } }), /non-isolated/);
  assert(server.requests.some(request => request.method === 'POST' && request.status === 405));
});

test('optional static cookie gate denies anonymous requests and records no cookie values', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'browser-auth-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'index.html'), '<title>protected fixture</title>');
  const server = await serveBrowserSite({ root, authorize: request => request.headers.cookie === 'fixture=owner' });
  t.after(() => server.close());
  assert.equal((await fetch(server.url)).status, 401);
  assert.equal((await fetch(server.url, { headers: { cookie: 'fixture=owner' } })).status, 200);
  assert.deepEqual(server.requests.map(request => [request.status, request.cookiePresent]), [[401, false], [200, true]]);
  assert(!JSON.stringify(server.requests).includes('owner'));
});

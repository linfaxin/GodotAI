import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { serveBrowserSite,serveIsolatedBrowserPair } from './browser-server.mjs';
import {execFileSync} from 'node:child_process';
import {get} from 'node:https';
import {readFile} from 'node:fs/promises';

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

test('explicit TLS isolated pair serves independent origins and delegates cross-origin isolation',async t=>{
  const root=await mkdtemp(resolve(tmpdir(),'browser-isolated-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(resolve(root,'index.html'),'<title>isolated fixture</title>');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',resolve(root,'key.pem'),'-out',resolve(root,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
  const pair=await serveIsolatedBrowserPair({root,tls:{key:await readFile(resolve(root,'key.pem')),cert:await readFile(resolve(root,'cert.pem'))}});t.after(()=>pair.close());
  const request=url=>new Promise((done,reject)=>get(url,{rejectUnauthorized:false},response=>{response.resume();response.on('end',()=>done(response));}).on('error',reject));
  assert.notEqual(pair.editor.origin,pair.preview.origin);assert.match(pair.editor.origin,/^https:/);
  const editor=await request(pair.editor.origin),preview=await request(pair.preview.origin);
  for(const response of [editor,preview]){assert.equal(response.statusCode,200);assert.equal(response.headers['cross-origin-opener-policy'],'same-origin');assert.equal(response.headers['cross-origin-embedder-policy'],'require-corp');}
  assert(editor.headers['permissions-policy'].includes(pair.preview.origin));assert.match(pair.iframeAllow,/cross-origin-isolated/);
  await assert.rejects(serveIsolatedBrowserPair({root}),/TLS/);
});

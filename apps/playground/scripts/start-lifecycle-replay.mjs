import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createStaticServer} from './serve.mjs';
import {digest} from './site-evidence.mjs';

const ports = process.argv.slice(2);
if (ports.length > 2 || ports.some(value => !/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535)) {
  throw new Error('Usage: node tools/start.mjs [editor-port] [preview-port]');
}
const [editorPort = '4173', previewPort = '4174'] = ports;
if (Number(editorPort) === Number(previewPort)) throw new Error('Choose two distinct ports');

const site = fileURLToPath(new URL('../site/', import.meta.url));
const host = '127.0.0.1';
const manifest = await readFile(new URL('../site/manifest.json', import.meta.url));
const publicImmutable = JSON.parse(manifest).publicAssets === true;
const prefix = publicImmutable ? '/releases/' + digest(manifest) + '/' : '/';
const options = {allowedEncodings: [], urlPrefix: prefix, publicImmutable};
const editor = createStaticServer(site, options);
const preview = createStaticServer(site, options);
const listen = (server, port) => {
  const listening = once(server, 'listening');
  server.listen(Number(port), host);
  return listening;
};

try {
  await Promise.all([listen(editor, editorPort), listen(preview, previewPort)]);
} catch (error) {
  editor.close();
  preview.close();
  throw error;
}

const url = new URL(`http://${host}:${editor.address().port}${prefix}`);
url.search = new URLSearchParams({project: 'native', presentationBackend: 'direct', previewOrigin: `http://${host}:${preview.address().port}${prefix}`});
console.log(`Playground: ${url.href}`);

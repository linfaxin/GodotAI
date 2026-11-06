#!/usr/bin/env node
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { options, required } from '../release/web-release-utils.mjs';
import { serveBrowserSite } from './browser-server.mjs';

// A development static host; compilation and PCK generation stay in the browser.
const args = options(process.argv.slice(2));
const source = resolve(required(args.site, '--site'));
const configuration = JSON.parse(await readFile(join(source, 'app-config.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'godotjs-playground-'));
let editor, preview, closing = false;
async function close() {
  if (closing) return; closing = true;
  await Promise.allSettled([editor?.close(), preview?.close()]);
  await rm(temporary, { recursive: true, force: true });
}
try {
  await cp(source, temporary, { recursive: true });
  preview = await serveBrowserSite({ root: temporary, host: 'localhost', port: Number(args['preview-port'] ?? 5174) });
  configuration.previewUrl = preview.url + '/preview.html';
  await writeFile(join(temporary, 'app-config.json'), JSON.stringify(configuration, null, 2));
  editor = await serveBrowserSite({ root: temporary, host: '127.0.0.1', port: Number(args.port ?? 5173) });
  console.log('GodotJS Playground: ' + editor.url);
  console.log('Separate preview origin: ' + preview.url);
  console.log('Press Ctrl+C to stop. Source artifacts are unchanged.');
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
} catch (error) { await close(); throw error; }

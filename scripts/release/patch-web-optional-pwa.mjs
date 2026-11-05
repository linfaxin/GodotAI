/** Tracked Godot 4.6.1 JavaScript-glue compatibility patch. Cross-site sandboxed
 * previews can deny ServiceWorker.getRegistration; this optional PWA discovery
 * must not emit an unhandled rejection. No native or WASM bytes are changed. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OPTIONAL_PWA_PATCH = 'godotjs-optional-pwa-v1';
export function patchOptionalPwa(code) {
  if (code.includes(OPTIONAL_PWA_PATCH)) return { code, changed: false, patchId: OPTIONAL_PWA_PATCH };
  const pattern = /navigator\.serviceWorker\.getRegistration\(\)\.then\(GodotPWA\.updateState\.bind\(null,\s*cb\)\)/g;
  const matches = [...code.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`E_PWA_PATCH_UNSUPPORTED: expected one Godot 4.6.1 PWA callback, found ${matches.length}`);
  const match = matches[0];
  if (code.slice(match.index + match[0].length).trimStart().startsWith('.catch(')) return { code, changed: false, patchId: OPTIONAL_PWA_PATCH };
  return { code: code.replace(pattern, call => `${call}.catch(function () { /* ${OPTIONAL_PWA_PATCH}: optional third-party PWA discovery */ })`), changed: true, patchId: OPTIONAL_PWA_PATCH };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: node patch-web-optional-pwa.mjs <godot.js | library_godot_os.js> [output]');
  const result = patchOptionalPwa(await readFile(input, 'utf8'));
  await writeFile(process.argv[3] ?? input, result.code);
  console.log(JSON.stringify({ patchId: result.patchId, changed: result.changed }));
}

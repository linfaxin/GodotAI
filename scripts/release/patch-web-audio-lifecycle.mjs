/** Godot 4.6.1 JS-glue patch for an AudioWorklet addModule continuation racing
 * close_async(), which clears GodotAudio.ctx before the continuation runs.
 * Applies to the SDK source or its known generated bundle; no WASM rewriting. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AUDIO_LIFECYCLE_PATCH = 'godotjs-audio-lifecycle-v1';
function once(code, pattern, replacement, label) {
  if ([...code.matchAll(new RegExp(pattern.source, 'g'))].length !== 1) throw new Error(`E_AUDIO_PATCH_UNSUPPORTED: ${label}`);
  return code.replace(pattern, replacement);
}
function closingBrace(code, start) {
  let depth = 0, quote = '', line = false, block = false;
  for (let i = start; i < code.length; i++) {
    const c = code[i], next = code[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && next === '/') { block = false; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '/' && next === '/') { line = true; i++; continue; }
    if (c === '/' && next === '*') { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return i;
  }
  throw new Error('E_AUDIO_PATCH_UNSUPPORTED: unbalanced known glue function');
}
export function patchAudioLifecycle(code) {
  if (code.includes(AUDIO_LIFECYCLE_PATCH)) return { code, changed: false, patchId: AUDIO_LIFECYCLE_PATCH };
  const declaration = /(?:const|var|let)\s+GodotAudioWorklet\s*=\s*\{/g;
  const definitions = [...code.matchAll(declaration)];
  if (definitions.length !== 1) throw new Error('E_AUDIO_PATCH_UNSUPPORTED: GodotAudioWorklet definition');
  const start = definitions[0].index;
  const open = code.indexOf('{', start);
  const end = closingBrace(code, open);
  let worklet = code.slice(start, end + 1);
  worklet = once(worklet, /GodotAudioWorklet\.promise\s*=\s*GodotAudio\.ctx\.audioWorklet\s*\.addModule\(path\)\s*\.then\(function\s*\(\)\s*\{\s*GodotAudioWorklet\.worklet\s*=\s*new AudioWorkletNode\(\s*GodotAudio\.ctx,/,
    `const lifecycleContext = GodotAudio.ctx; /* ${AUDIO_LIFECYCLE_PATCH} */
      GodotAudioWorklet.context = lifecycleContext;
      GodotAudioWorklet.closing = false;
      GodotAudioWorklet.promise = lifecycleContext.audioWorklet.addModule(path).then(function () {
        if (GodotAudioWorklet.closing || GodotAudio.ctx !== lifecycleContext || lifecycleContext.state === 'closed') return;
        GodotAudioWorklet.worklet = new AudioWorkletNode(lifecycleContext,`, 'create continuation');
  const nodePattern = /const node\s*=\s*GodotAudioWorklet\.worklet\s*;/g;
  if ([...worklet.matchAll(nodePattern)].length !== 2) throw new Error('E_AUDIO_PATCH_UNSUPPORTED: both start continuations');
  worklet = worklet.replace(nodePattern, match => `${match}\nif (!node || !GodotAudio.ctx || GodotAudioWorklet.closing) return;`);
  const close = /close:\s*function\s*\(\)\s*\{/g;
  const closes = [...worklet.matchAll(close)];
  if (closes.length !== 1) throw new Error('E_AUDIO_PATCH_UNSUPPORTED: close function');
  const closeStart = closes[0].index + closes[0][0].indexOf('function');
  const closeOpen = worklet.indexOf('{', closeStart);
  const closeEnd = closingBrace(worklet, closeOpen);
  worklet = worklet.slice(0, closeStart) + `function () {
    GodotAudioWorklet.closing = true;
    const pending = GodotAudioWorklet.promise;
    function finish() {
      const node = GodotAudioWorklet.worklet;
      try {
        if (node) { node.port.postMessage({ cmd: 'stop', data: null }); node.disconnect(); }
      } finally {
        if (node) { node.port.onmessage = null; node.port.close(); }
        GodotAudioWorklet.worklet = null;
        GodotAudioWorklet.promise = null;
        GodotAudioWorklet.ring_buffer = null;
        GodotAudioWorklet.context = null;
      }
    }
    if (pending === null) { finish(); return Promise.resolve(); }
    return pending.then(finish, function (error) {
      const context = GodotAudioWorklet.context;
      if (!(error && error.name === 'AbortError' && context && context.state === 'closed')) {
        GodotRuntime.error('Error loading AudioWorklet during shutdown', error);
      }
      finish();
    });
  }` + worklet.slice(closeEnd + 1);
  code = code.slice(0, start) + worklet + code.slice(end + 1);
  code = once(code, /GodotAudio\.audioPositionWorkletPromise\s*=\s*ctx\.audioWorklet\.addModule\(path\)/,
    `GodotAudio.audioPositionWorkletPromise = ctx.audioWorklet.addModule(path).catch(function (error) {
      // Only a canceled/retired context makes this optional continuation obsolete.
      if (GodotAudio.ctx !== ctx || ctx.state === 'closed') return;
      throw error;
    })`, 'position worklet promise');
  return { code, changed: true, patchId: AUDIO_LIFECYCLE_PATCH };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: node patch-web-audio-lifecycle.mjs <godot.js | library_godot_audio.js> [output]');
  const result = patchAudioLifecycle(await readFile(input, 'utf8'));
  await writeFile(process.argv[3] ?? input, result.code);
  console.log(JSON.stringify({ patchId: result.patchId, changed: result.changed }));
}

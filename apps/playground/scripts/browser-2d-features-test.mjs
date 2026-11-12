import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, writeFile, mkdir, access} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {packProject} from '@godot-js/react-browser/pck';
import {launchTestBrowser, withAcceptanceContext} from './browser-harness.mjs';
import {assessStoppedAudio} from './feature-audio-evidence.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const marker = 'GODOTJS_2D_FEATURES';
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => new TextEncoder().encode(value);
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };

export function validateFeatureNamings(namings) {
 if(!Array.isArray(namings)||namings.length<1||namings.length>2||new Set(namings).size!==namings.length||!namings.every(value=>value==='snake'||value==='camel'))throw Error('E_FEATURE_NAMING: expected a nonempty unique snake/camel list');
 return namings;
}

export function observeFeaturePage(page){
 const observed={logs:[],errors:[],consoleErrors:[]};
 page.on('console',event=>{
  const message=event.text();observed.logs.push(message);
  if(event.type()==='error')observed.consoleErrors.push(message);
 });
 page.on('pageerror',error=>observed.errors.push(String(error)));
 return observed;
}

async function testFont(explicit) {
 const choices = explicit ? [explicit] : [
  path.join(repo, 'apps/playground/scripts/fixtures/engine-2d/test-cjk.otf'),
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  path.join(repo, 'tests/react/showcase/fixtures/ui-subset.ttf'),
 ];
 for (const filename of choices) {
  try { await access(filename); return {filename: path.resolve(filename), bytes: await readFile(filename)}; }
  catch (error) { if (explicit) throw error; }
 }
 throw Error('E_FEATURE_FONT: supply --font pointing to an actual test font');
}

export async function create2dFeatureFixture({naming = 'snake', fontBytes, requireCjk = false} = {}) {
 validateFeatureNamings([naming]);
 const source = await readFile(new URL('./fixtures/engine-2d/features.cjs', import.meta.url));
 const files = new Map([
  ['res://project.godot', encode('config_version=5\n[application]\nconfig/name="Real 2D feature acceptance"\nrun/main_scene="res://main.tscn"\n[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=240\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nenvironment/defaults/default_clear_color=Color(0.02,0.03,0.04,1)\n[physics]\n2d/physics_engine="GodotPhysics2D"\n[GodotJS]\nruntime/debugger/debugger_port=0\nruntime/core/camel_case_bindings_enabled=' + String(naming === 'camel') + '\n')],
  ['res://main.tscn', encode('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://FeatureProbe.ts" id="1"]\n[node name="FeatureProbe" type="Node2D"]\nscript=ExtResource("1")\n')],
  ['res://FeatureProbe.ts', encode('export default class FeatureProbe {}\n')],
  ['res://.godot/GodotJS/FeatureProbe.js', source],
  ['res://.godot/global_script_class_cache.cfg', encode('list=Array[Dictionary]([])\n')],
  ['res://feature-config.js', encode('module.exports=' + JSON.stringify({naming, requireCjk, labelText: requireCjk ? '中文' : 'Native 2D UI'}) + ';\n')],
  ['res://font.ttf', fontBytes],
 ]);
 return {files, sourceSha256: hash(source)};
}

/** Observe real browser audio objects and samples; do not substitute the audio implementation. */
function observeAudio() {
 const originalLog = console.log.bind(console);
 console.log = (...args) => {
  const text = args.join(' ');
  if (text.includes('GODOTJS_2D_FEATURES')) {
   globalThis.__features?.events.push(text);
   if (text.includes('_AUDIO_STOPPED') || text.includes('_AUDIO_RESTARTED')) {
    globalThis.__featureAudioPhase = text.includes('_AUDIO_STOPPED') ? 'stopped' : 'restarted';
    globalThis.__featureAudioPhaseAt = performance.now();
   }
  }
  originalLog(...args);
 };
 const records = [], Native = globalThis.AudioContext ?? globalThis.webkitAudioContext;
 globalThis.__featureAudio = records;
 globalThis.__featureAudioPhase = 'initial'; globalThis.__featureAudioPhaseAt = performance.now();
 if (!Native) return;
 globalThis.AudioContext = new Proxy(Native, {construct(target, args, newTarget) {
  const context = Reflect.construct(target, args, newTarget);
  const record = {context, worklets: [], meters: [], closeCalls: 0, closed: false}; records.push(record);
  const add = context.audioWorklet.addModule.bind(context.audioWorklet);
  context.audioWorklet.addModule = async (...input) => { await add(...input); record.worklets.push(String(input[0])); };
  const close = context.close.bind(context);
  context.close = async (...input) => {
   record.closeCalls++; for (const meter of record.meters) clearInterval(meter.timer);
   await close(...input); record.closed = context.state === 'closed';
  };
  return context;
 }});
 const NativeNode = globalThis.AudioWorkletNode;
 if (NativeNode) globalThis.AudioWorkletNode = new Proxy(NativeNode, {construct(target, args, newTarget) {
  const node = Reflect.construct(target, args, newTarget), context = args[0], record = records.find(item => item.context === context);
  if (record && node.numberOfOutputs > 0) {
   const analyser = context.createAnalyser(); analyser.fftSize = 256; node.connect(analyser);
   // Firefox only processes this observer branch continuously when it is
   // pulled by the real destination. Keep the original audible route intact.
   const silent = context.createGain(); silent.gain.value = 0; analyser.connect(silent); silent.connect(context.destination);
   const data = new Float32Array(analyser.fftSize);
   const meter = {name: String(args[1]), initialPeak: 0, restartedPeak: 0, stoppedPeak: 0, quietSamples: 0, stoppedSamples: []}; record.meters.push(meter);
   meter.timer = setInterval(() => {
    analyser.getFloatTimeDomainData(data); let peak = 0; for (const value of data) peak = Math.max(peak, Math.abs(value));
    const phase = globalThis.__featureAudioPhase;
    if (phase === 'initial') meter.initialPeak = Math.max(meter.initialPeak, peak);
    if (phase === 'restarted') meter.restartedPeak = Math.max(meter.restartedPeak, peak);
    if (phase === 'stopped') meter.stoppedSamples.push({ms: performance.now() - globalThis.__featureAudioPhaseAt, peak});
   }, 25);
  }
  return node;
 }});
}

export async function run2dFeatureAcceptance({directory, engineJs, engineWasm, out, reportFile, browser: browserName = 'chromium', font: fontPath, requireCjk, namings = ['snake', 'camel'], sessions = 2, timeout = 120000} = {}) {
 validateFeatureNamings(namings);
 if (!Number.isInteger(sessions) || sessions < 1 || sessions > 10) throw Error('E_FEATURE_SESSIONS');
 directory = directory ? path.resolve(directory) : undefined;
 const release = directory ? JSON.parse(await readFile(path.join(directory, 'engine-release.json'), 'utf8')) : undefined;
 engineJs = path.resolve(engineJs ?? (release ? path.join(directory, release.engine.javascript.path) : path.join(repo, 'apps/playground/dist/engine/game.js')));
 engineWasm = path.resolve(engineWasm ?? (release ? path.join(directory, release.engine.wasm.path) : engineJs.replace(/\.js$/, '.wasm')));
 out = path.resolve(out ?? (reportFile ? path.dirname(reportFile) : path.join(repo, 'work/2d-engine/features'))); await mkdir(out, {recursive: true});
 reportFile = path.resolve(reportFile ?? path.join(out, 'features.json')); await mkdir(path.dirname(reportFile), {recursive: true});
 const [javascript, servedWasm, font] = await Promise.all([readFile(engineJs), readFile(engineWasm), testFont(fontPath)]);
 const wasm = release?.engine.wasm.encoding === 'gzip' ? gunzipSync(servedWasm) : servedWasm;
 if (release) {
  assert.equal(hash(javascript), release.engine.javascript.sha256, 'Test JavaScript must match the site descriptor');
  assert.equal(hash(servedWasm), release.engine.wasm.sha256, 'Test WASM must match the site descriptor');
  if (release.engine.wasm.decodedSha256) assert.equal(hash(wasm), release.engine.wasm.decodedSha256, 'Decoded WASM identity');
 }
 assert.equal(WebAssembly.validate(wasm), true, 'Engine WASM validation');
 const requireChinese = requireCjk ?? /cjk|wqy|zenhei/i.test(font.filename);
 const worklets = new Map();
 for (const suffix of ['.audio.worklet.js', '.audio.position.worklet.js']) {
  const descriptor = release?.engine.worklets?.find(item => item.path.endsWith(suffix));
  const bytes = await readFile(descriptor ? path.join(directory, descriptor.path) : engineJs.replace(/\.js$/, suffix));
  if (release) { assert(descriptor, 'Site worklet descriptor: ' + suffix); assert.equal(hash(bytes), descriptor.sha256, 'Test worklet identity'); }
  worklets.set('/engine/godot' + suffix, bytes);
 }
 let pack;
 const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const route = pathname === '/' ? {type: 'text/html', bytes: '<!doctype html><style>html,body{margin:0;background:#222}canvas{width:320px;height:240px}</style><canvas id="canvas" tabindex="0" width="320" height="240"></canvas><script src="/engine/godot.js"></script>'}
   : pathname === '/fixture.pck' ? {type: 'application/octet-stream', bytes: pack}
   : pathname === '/engine/godot.js' ? {type: 'text/javascript', bytes: javascript}
   : pathname === '/engine/godot.wasm' ? {type: 'application/wasm', bytes: wasm}
   : worklets.has(pathname) ? {type: 'text/javascript', bytes: worklets.get(pathname)} : undefined;
  if (!route) { response.writeHead(pathname === '/favicon.ico' ? 204 : 404).end(); return; }
  response.writeHead(200, {'content-type': route.type, 'cache-control': 'no-store'}).end(route.bytes);
 });
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
 const report = {schemaVersion: 1, suite: '2d-features', status: 'running', testMode: 'real-engine', runId: randomUUID(), engine: {javascript: hash(javascript), wasm: hash(wasm), wasmBytes: wasm.length, worklets: Object.fromEntries([...worklets].map(([name, bytes]) => [name, hash(bytes)]))}, font: {path: font.filename, sha256: hash(font.bytes), bytes: font.bytes.length, cjkRequired: requireChinese}, cases: []};
 let browser;
 try {
  browser = await launchTestBrowser({browser: browserName, headless: true, args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']});
  report.browser = {name: browser.browserType().name(), version: browser.version()};
  for (const naming of namings) for (let session = 1; session <= sessions; session++) {
   if (!['snake', 'camel'].includes(naming)) throw Error('E_FEATURE_NAMING');
   const fixture = await create2dFeatureFixture({naming, fontBytes: font.bytes, requireCjk: requireChinese}); pack = packProject(fixture.files, {maxBytes: 64 * 1024 * 1024}).pack;
   const context = await browser.newContext({viewport: {width: 320, height: 240}}); await context.addInitScript(observeAudio);
   const page = await context.newPage(), {logs,errors,consoleErrors}=observeFeaturePage(page);
   const entry = {naming, session, packSha256: hash(pack), sourceSha256: fixture.sourceSha256, screenshot: naming + '-' + session + '.png', errors, consoleErrors, logs}; report.cases.push(entry);
   try {
    await page.goto('http://127.0.0.1:' + server.address().port + '/');
    await page.evaluate(async () => {
     window.__features = {events: [], exitCode: null};
     const bytes = new Uint8Array(await (await fetch('/fixture.pck')).arrayBuffer());
     let resolveExit; const exit = new Promise(resolve => resolveExit = resolve);
     const engine = new Engine({canvas: document.querySelector('canvas'), executable: '/engine/godot', persistentPaths: [], persistentDrops: false, serviceWorker: '',
      onPrint: (...args) => {
       const text = args.join(' '); window.__features.events.push(text);
       if (text.includes('GODOTJS_2D_FEATURES_AUDIO_STOPPED') || text.includes('GODOTJS_2D_FEATURES_AUDIO_RESTARTED')) {
        window.__featureAudioPhase = text.includes('_AUDIO_STOPPED') ? 'stopped' : 'restarted'; window.__featureAudioPhaseAt = performance.now();
       }
      },
      onPrintError: (...args) => window.__features.events.push('ERROR ' + args.join(' ')),
      onExit: code => { window.__features.exitCode = code; resolveExit(); }});
     window.__features.engine = engine;
     await engine.preloadFile(bytes, '/application.pck'); await engine.init('/engine/godot');
     await Promise.race([engine.start({args: ['--main-pack', '/application.pck', '--rendering-method', 'gl_compatibility']}), exit]);
    });
    await page.waitForFunction(() => window.__features.events.some(value => value.includes('GODOTJS_2D_FEATURES_READY')) || window.__features.exitCode !== null, null, {timeout});
    if (await page.evaluate(() => window.__features.exitCode === null)) {
     await page.locator('canvas').click({position: {x: 245, y: 185}});
     await page.waitForFunction(() => window.__features.events.some(value => value.includes('GODOTJS_2D_FEATURES_RENDERED')) || window.__features.exitCode !== null, null, {timeout});
     if (await page.evaluate(() => window.__features.exitCode === null)) await page.screenshot({path: path.join(out, entry.screenshot)});
    }
    await page.waitForFunction(() => window.__features.exitCode !== null, null, {timeout});
    await page.waitForFunction(() => globalThis.__featureAudio.every(record => record.closed), null, {timeout: 15000});
    const observed = await page.evaluate(() => ({events: window.__features.events, exitCode: window.__features.exitCode, audio: globalThis.__featureAudio.map(record => ({state: record.context.state, closed: record.closed, closeCalls: record.closeCalls, worklets: record.worklets, meters: record.meters.map(({timer, ...meter}) => meter)}))}));
    Object.assign(entry, observed);
    const line = observed.events.find(value => value.includes(marker + ' ')); entry.result = line ? JSON.parse(line.slice(line.indexOf(marker + ' ') + marker.length + 1)) : undefined;
    assert.equal(observed.exitCode, 0, JSON.stringify(entry)); assert.equal(entry.result?.status, 'passed', JSON.stringify(entry)); assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors, [], 'Browser console errors, including WebGL validation errors, must fail acceptance');
    entry.nativeErrors = observed.events.filter(value => /^ERROR (?:ERROR|SCRIPT ERROR):/.test(value));
    assert.deepEqual(entry.nativeErrors, [], 'Native engine errors must not be hidden by successful feature assertions');
    entry.lifecycleWarnings = observed.events.filter(value => /WARNING:.*(?:leaked|orphan)|Pages in use exist/.test(value));
    assert.deepEqual(entry.lifecycleWarnings, [], 'Native lifecycle warnings must not be hidden');
    assert(observed.audio.length > 0, 'A real AudioContext must be created');
    assert(observed.audio.every(record => record.closed && record.closeCalls === 1 && record.worklets.length >= 2), 'Every fresh engine session must load both worklets and close audio exactly once');
    const meters = observed.audio.flatMap(record => record.meters);
    for(const meter of meters){
     meter.stoppedEvidence=assessStoppedAudio(meter.stoppedSamples);
     if(meter.stoppedEvidence.status==='passed')for(const key of ['drainMs','quietMs','quietSamples','stoppedPeak'])meter[key]=meter.stoppedEvidence[key];
    }
    assert(meters.some(meter => meter.initialPeak > 0.001), 'Initial real audio output must be nonzero after the browser gesture');
    assert(meters.some(meter => meter.restartedPeak > 0.001), 'Restarted real audio output must be nonzero');
    assert(meters.length&&meters.every(meter => meter.stoppedEvidence.status==='passed'), 'Stopped playback must drain within 300 ms and remain silent for 500 ms: '+JSON.stringify(meters.map(meter=>meter.stoppedEvidence)));
    entry.status = 'passed';
   } catch (error) {
    entry.status = 'failed'; entry.error = String(error.stack ?? error);
    entry.state = await page.evaluate(() => ({events: window.__features?.events, exitCode: window.__features?.exitCode})).catch(() => undefined);
    throw error;
   } finally { await context.close(); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); }
  }
  report.status = 'passed';
  if (directory) Object.assign(report, await withAcceptanceContext(report, {directory, browser, testMode: 'real-engine'}));
 } catch (error) { report.status = 'failed'; report.error = String(error.stack ?? error); throw error; }
 finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); }
 return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
 try {
  const report = await run2dFeatureAcceptance({directory: argument('--site') ?? process.env.PLAYGROUND_TEST_DIRECTORY, engineJs: argument('--engine-js'), engineWasm: argument('--engine-wasm'), out: argument('--out'), reportFile: argument('--report') ?? process.env.PLAYGROUND_2D_FEATURES_REPORT, browser: argument('--browser') ?? process.env.BROWSER ?? 'chromium', font: argument('--font'), requireCjk: process.argv.includes('--require-cjk') ? true : undefined, namings: argument('--naming') ? [argument('--naming')] : ['snake', 'camel'], sessions: Number(argument('--sessions') ?? '2')});
  console.log(JSON.stringify({status: report.status, cases: report.cases.length, browser: report.browser, cjkRequired: report.font.cjkRequired}));
 } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}

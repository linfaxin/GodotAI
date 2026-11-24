/** Native GameProbe verification without importing Playground's demo assets. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {packProject} from '@godot-js/react-browser/pck';
import {createArtifactIdentity} from '@godot-js/engine/identities';
import {assertWorkerBuildProof} from './worker-candidate.mjs';
import {launchBrowser} from './browser-harness.mjs';

const [reportFile, out] = process.argv.slice(2);
if (!reportFile || !out) throw Error('Usage: browser-game-probe-g0.mjs <engine-report.json> <report-directory>');
const root = fileURLToPath(new URL('../', import.meta.url));
const encoder = new TextEncoder();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reportBytes = await readFile(reportFile);
const report = JSON.parse(reportBytes);
assertWorkerBuildProof(report);
assert.equal(report.runtimeAbi.gameProbe, 1);
await mkdir(out, {recursive: true});

const previewRoutes = new Map(), editorRoutes = new Map();
async function serve(routes) {
  const server = createServer((request, response) => {
    const entry = routes.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!entry) {response.writeHead(404).end(); return;}
    response.writeHead(200, {'Content-Type': entry.type, 'Cache-Control': 'no-store'});
    response.end(entry.bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {server, origin: 'http://127.0.0.1:' + server.address().port};
}
const preview = await serve(previewRoutes), editor = await serve(editorRoutes);
const asset = (name, bytes, type = 'text/javascript') => {
  previewRoutes.set('/' + name, {type, bytes});
  return {url: preview.origin + '/' + name, bytes: bytes.byteLength, sha256: hash(bytes)};
};
function fromTemplate(name, type) {
  const result = spawnSync('unzip', ['-p', report.template.path, name], {maxBuffer: 256 * 1024 * 1024});
  if (result.status !== 0) throw Error('Template asset missing: ' + name);
  const descriptor = asset(name, result.stdout, type);
  const expected = report.template.assets.find(item => item.path === name);
  assert.equal(descriptor.sha256, expected.sha256);
  assert.equal(descriptor.bytes, expected.bytes);
  return descriptor;
}
async function bundle(contents) {
  const result = await build({stdin: {contents, resolveDir: root, loader: 'js'}, bundle: true,
    platform: 'browser', format: 'iife', target: 'es2022', write: false});
  return result.outputFiles[0].contents;
}

const fixture = (mode) => {
  const script = `
extends Node2D
var frames := 0
var nesting := false
var quit_on_draw := false
@onready var player: Node2D = $Player

func _ready():
    RenderingServer.frame_post_draw.connect(after_draw)
    if "${mode}" in ["paused-render", "manual", "quit"]:
        RenderingServer.render_loop_enabled = false
    if "${mode}" == "pre-force":
        RenderingServer.frame_pre_draw.connect(force_nested)
    if "${mode}" == "direct-to-screen":
        RenderingServer.viewport_set_render_direct_to_screen(get_tree().root.get_viewport_rid(), true)
    if "${mode}" == "non-root":
        var secondary := SubViewport.new()
        secondary.size = Vector2i(320, 240)
        secondary.render_target_update_mode = SubViewport.UPDATE_ALWAYS
        add_child(secondary)
        RenderingServer.viewport_attach_to_screen(get_tree().root.get_viewport_rid(), Rect2(), DisplayServer.INVALID_WINDOW_ID)
        RenderingServer.viewport_attach_to_screen(secondary.get_viewport_rid(), Rect2(0, 0, 320, 240))

func _process(_delta):
    frames += 1
    player.position = Vector2(48 + (frames % 3) * 64, 120)
    if "${mode}" == "manual":
        RenderingServer.force_draw(true)

func after_draw():
    player.position.x = 290
    if "${mode}" == "post-force":
        force_nested()
    if quit_on_draw:
        get_tree().quit()

func force_nested():
    if nesting:
        return
    nesting = true
    RenderingServer.force_draw(true)
    nesting = false

func _input(event):
    if "${mode}" == "quit" and event is InputEventKey and event.pressed and event.keycode == KEY_SPACE:
        quit_on_draw = true
        RenderingServer.render_loop_enabled = true
`;
  return new Map(Object.entries({
    'res://project.godot': 'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[audio]\ndriver/driver="Dummy"\n[display]\nwindow/size/viewport_width=320\nwindow/size/viewport_height=240\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nenvironment/defaults/default_clear_color=Color(0, 0, 0, 1)\n[GodotJS]\nruntime/debugger/debugger_port=0\n',
    'res://main.tscn': '[gd_scene load_steps=3 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[ext_resource type="Script" path="res://Anchor.ts" id="2"]\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n[node name="Player" type="Node2D" parent="."]\nscript = ExtResource("2")\n[node name="Marker" type="Polygon2D" parent="Player"]\npolygon = PackedVector2Array(-12, -12, 12, -12, 12, 12, -12, 12)\ncolor = Color(1, 1, 1, 1)\n',
    'res://main.gd': script,
    'res://Anchor.ts': 'export default class Anchor {}',
    'res://.godot/GodotJS/Anchor.js': 'exports.default = class Anchor extends require("godot").Node2D {};',
    'res://.godot/global_script_class_cache.cfg': 'list=Array[Dictionary]([])\n',
  }).map(([name, text]) => [name, encoder.encode(text)]));
};

const evidence = {status: 'failed', engineExecuted: false, templateSha256: report.template.sha256,
  engineReportSha256: hash(reportBytes), cases: []};
let browser, page;
const pageErrors = [], browserErrors = [];
try {
  const release = {
    runtimeAbi: report.runtimeAbi, artifactReceiptVersion: 2, profile: report.runtimeProfile,
    engineTarget: report.engineTarget, execution: report.execution, allowedOrigins: [preview.origin],
    engineJs: fromTemplate('godot.js', 'text/javascript'),
    engineWasm: fromTemplate('godot.wasm', 'application/wasm'),
    worklets: ['godot.audio.worklet.js', 'godot.audio.position.worklet.js'].map(name => ({name, ...fromTemplate(name, 'text/javascript')})),
    runtimeWorker: asset('runtime.worker.js', await bundle(
      'import {installWorkerRuntime} from "@godot-js/engine/browser/dedicated/worker-runtime"; installWorkerRuntime();')),
    runtimeAudioWorklet: asset('runtime.audio.worklet.js', await bundle('import "../../packages/engine/src/browser/dedicated/worker-audio-worklet.ts";')),
  };
  release.releaseId = hash(JSON.stringify({engine: [release.engineJs.sha256, release.engineWasm.sha256],
    host: [release.runtimeWorker.sha256, release.runtimeAudioWorklet.sha256], abi: release.runtimeAbi}));
  evidence.releaseId = release.releaseId;
  const artifacts = {};
  const modes = ['live', 'paused-render', 'manual', 'pre-force', 'post-force', 'non-root', 'direct-to-screen', 'quit'];
  for (const mode of modes) {
    const files = fixture(mode), pack = packProject(files).pack;
    const outputs = [...files].map(([path, bytes]) => ({path, disposition: 'generated', outputHash: hash(bytes)}));
    const sourceHash = hash(JSON.stringify(outputs));
    const buildKey = hash(JSON.stringify([sourceHash, release.releaseId]));
    const artifact = {schemaVersion: 2, buildKey, sourceHash, packSha256: hash(pack), outputs};
    const artifactId = await createArtifactIdentity(artifact);
    artifacts[mode] = {revision: 1, generation: mode, buildKey, artifactId, packSha256: artifact.packSha256, manifest: {
      generation: mode, engineReleaseId: release.releaseId, engineProfile: release.profile, artifactReceipt: {...artifact, artifactId},
    }};
    editorRoutes.set('/' + mode + '.pck', {type: 'application/octet-stream', bytes: pack});
  }

  const host = await bundle(`
    import {startWorkerPreviewHost} from '@godot-js/engine/browser/dedicated/worker-host';
    import {isWorkerEnvelope} from '@godot-js/engine/browser/dedicated/worker-protocol';
    import {assertArtifactReceipt} from '@godot-js/engine/identities';
    const origin = ${JSON.stringify(editor.origin)}, expected = ${JSON.stringify(release)};
    let connected = false;
    addEventListener('message', event => {
      const message = event.data;
      if (connected || event.origin !== origin || event.source !== parent || !isWorkerEnvelope(message) ||
          message.type !== 'connect' || message.editorOrigin !== origin || event.ports.length !== 1) return;
      connected = true;
      startWorkerPreviewHost(message, event.ports[0], {
        canvas: document.querySelector('canvas'),
        async verifyRelease(actual, manifest, signal, artifact) {
          if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('G0 release identity differs');
          await assertArtifactReceipt(manifest.artifactReceipt, {pack: artifact.pack, buildKey: artifact.buildKey, artifactId: artifact.artifactId});
        },
      });
    });
  `);
  const runner = await bundle(`
    import {WorkerPreviewRunner} from '@godot-js/engine/browser/dedicated/worker-runner';
    const runner = new WorkerPreviewRunner({container: document.querySelector('main'), previewUrl: ${JSON.stringify(preview.origin + '/')},
      release: ${JSON.stringify(release)}, configuration: {presentationBackend: 'direct'}});
    window.probeRunner = runner;
    window.probeLogs = [];
    runner.subscribe(event => { if (event.type === 'log' || event.type === 'diagnostic') window.probeLogs.push(event); });
    const artifacts = ${JSON.stringify(artifacts)};
    window.startProbeFixture = async mode => {
      const pack = new Uint8Array(await (await fetch('/' + mode + '.pck')).arrayBuffer());
      return runner.run({...artifacts[mode], pack});
    };
  `);
  previewRoutes.set('/', {type: 'text/html', bytes: '<!doctype html><style>html,body,canvas{width:100%;height:100%;margin:0;display:block}</style><canvas></canvas><script src="/host.js"></script>'});
  previewRoutes.set('/host.js', {type: 'text/javascript', bytes: host});
  editorRoutes.set('/', {type: 'text/html', bytes: '<!doctype html><style>main,iframe{width:320px;height:240px;display:block;border:0}</style><main></main><script src="/runner.js"></script>'});
  editorRoutes.set('/runner.js', {type: 'text/javascript', bytes: runner});

  browser = await launchBrowser({browser: 'chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  page = await browser.newPage({viewport: {width: 640, height: 480}, deviceScaleFactor: 1});
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', msg => { if (msg.type() === 'error') browserErrors.push(msg.text()); });
  await page.goto(editor.origin);
  const live = await page.evaluate(() => window.startProbeFixture('live'));
  evidence.engineExecuted = true;
  const picture = await page.evaluate(async ({runId}) => {
    const runner = window.probeRunner, props = [{path: '/root/Main/Player', property: 'position'}];
    const result = await runner.gameProbe({runId, props});
    if (!result.ok) return {result};
    const state = await runner.gameProbe({runId, props, screenshot: false});
    const {bytes, ...metadata} = result.result.image;
    const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const point = x => Array.from(context.getImageData(x, 120, 1, 1).data);
    return {result: {...result, result: {...result.result, image: metadata}}, state,
      pixel: point(result.result.properties[0].value.x), latePixel: point(290), png: Array.from(new Uint8Array(bytes))};
  }, live);
  assert.equal(picture.result.ok, true, JSON.stringify(picture.result));
  assert.equal(picture.result.result.mode, 'rendered');
  assert.deepEqual(picture.pixel, [255, 255, 255, 255]);
  assert.equal(picture.state.result.properties[0].value.x, 290);
  assert.deepEqual(picture.latePixel, [0, 0, 0, 255]);
  await writeFile(path.join(out, 'paired.png'), Buffer.from(picture.png));
  delete picture.png;
  const bounds = await page.evaluate(async ({runId}) => {
    const props = [{path: '/root/Main/Player', property: 'position'}, {path: '/root/Main/Player', property: 'health'},
      {path: '/root/Main/Missing', property: 'position'}];
    const sample = await window.probeRunner.gameProbe({runId, tree: {path: '/root/Main', limit: 2}, props, maxDimension: 80});
    if (!sample.ok) return sample;
    const {bytes, ...metadata} = sample.result.image;
    return {...sample, result: {...sample.result, image: metadata}};
  }, live);
  assert.equal(bounds.ok, true, JSON.stringify(bounds));
  assert.deepEqual([bounds.result.image.width, bounds.result.image.height], [80, 60]);
  assert.equal(bounds.result.tree.truncated, true);
  assert.deepEqual(bounds.result.tree.nodes.map(node => node.path), ['/root/Main', '/root/Main/Player']);
  assert.deepEqual(bounds.result.properties.map(item => item.reason), [undefined, 'unsupported_property', 'node_not_found']);
  const stop = () => page.evaluate(() => window.probeRunner.stop());
  const exit = await stop();
  assert.equal(exit.engineOutcome?.code, 0, JSON.stringify(exit));
  assert.equal(exit.hostCleanup?.status, 'complete');
  evidence.cases.push({name: 'paired-and-late-read', ...picture, bounds, run: live, exit});

  for (const mode of ['paused-render', 'manual', 'non-root', 'pre-force', 'post-force', 'direct-to-screen']) {
    const run = await page.evaluate(arg => window.startProbeFixture(arg), mode);
    const results = await page.evaluate(async ({runId}) => ({
      state: await window.probeRunner.gameProbe({runId, screenshot: false}),
      rendered: await window.probeRunner.gameProbe({runId, timeoutMs: 300}),
    }), run);
    assert.equal(results.state.ok, true, JSON.stringify(results));
    assert.equal(results.state.result.image, null);
    const expected = mode === 'pre-force' || mode === 'post-force' ? 'probe_failed' :
      mode === 'direct-to-screen' ? 'unsupported' : 'timeout';
    assert.equal(results.rendered.error?.code, expected, JSON.stringify(results));
    if (expected === 'probe_failed') assert.equal(results.rendered.error.reason, 'ambiguous_frame');
    if (mode === 'direct-to-screen') assert.equal(results.rendered.error.reason, 'direct_to_screen');
    if (mode === 'non-root') {
      const committed = await page.evaluate(async ({runId}) => (await window.probeRunner.screenshot({runId, timeoutMs: 1000})).ok, run);
      assert.equal(committed, true, 'A non-root draw can commit successfully without admitting a game probe');
    }
    const modeExit = await stop();
    assert.equal(modeExit.engineOutcome?.code, 0, JSON.stringify(modeExit));
    assert.equal(modeExit.hostCleanup?.status, 'complete');
    evidence.cases.push({name: mode, run, ...results, exit: modeExit});
  }
  const quit = await page.evaluate(async () => {
    const run = await window.startProbeFixture('quit'), {runId} = run, runner = window.probeRunner;
    const exit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(Error('No native quit receipt')); }, 6000);
      const unsubscribe = runner.subscribe(event => {
        if (event.type === 'exit' && event.report.runId === runId) {
          unsubscribe(); clearTimeout(timer); resolve(event.report);
        }
      });
    });
    const pending = runner.gameProbe({runId});
    const input = await runner.gameInput({runId, gesture: {kind: 'key_tap', code: 'Space'}});
    return {run, result: await pending, input, exit: await exit};
  });
  assert.equal(quit.input.ok, true, JSON.stringify(quit.input));
  assert.equal(quit.result.error?.code, 'run_ended', JSON.stringify(quit));
  assert.equal(quit.exit.engineOutcome?.code, 0);
  assert.equal(quit.exit.hostCleanup?.status, 'complete');
  evidence.cases.push({name: 'quit-after-commit', ...quit});
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(browserErrors.filter(message => /WebGL|GL_INVALID/i.test(message)), []);
  evidence.status = 'passed';
} catch (error) {
  evidence.error = String(error.stack ?? error);
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  evidence.pageErrors = pageErrors;
  evidence.browserErrors = browserErrors;
  if (page) evidence.logs = await page.evaluate(() => window.probeLogs).catch(() => []);
  await browser?.close();
  for (const {server} of [preview, editor]) {server.close(); server.closeAllConnections();}
  await writeFile(path.join(out, 'game-probe-g0.json'), JSON.stringify(evidence, null, 2) + '\n');
}

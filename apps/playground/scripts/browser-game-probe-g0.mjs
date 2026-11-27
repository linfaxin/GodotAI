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
import {inputModes, verifyInputScriptCase} from './verify-input-script-g0.mjs';

const inputOnly = process.argv[2] === '--input-script';
const [reportFile, out] = process.argv.slice(inputOnly ? 3 : 2);
if (!reportFile || !out) throw Error('Usage: browser-game-probe-g0.mjs [--input-script] <engine-report.json> <report-directory>');
const root = fileURLToPath(new URL('../', import.meta.url));
const encoder = new TextEncoder();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const reportBytes = await readFile(reportFile);
const report = JSON.parse(reportBytes);
assertWorkerBuildProof(report);
assert.equal(report.runtimeAbi.gameProbe, 1);
if (inputOnly) assert.equal(report.runtimeAbi.inputScript, 1);
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
  const result = spawnSync('unzip', ['-p', path.resolve(path.dirname(reportFile), report.template.path), name], {maxBuffer: 256 * 1024 * 1024});
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
  if (mode.startsWith('input-')) return inputScriptFixture(mode);
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

const keyPauseMode = 'input-key-pause-resume';
const keyCancelMode = 'input-key-cancel-no-raf';
const inputFixtureModes = [...inputModes, keyPauseMode, keyCancelMode];

function inputScriptFixture(mode) {
  const camel = mode === 'input-camel';
  const usesKey = mode === keyPauseMode || mode === keyCancelMode;
  const ticks = mode === 'input-zero' ? 15 : mode === 'input-multi' ? 240 : 60;
  const player = [
    'const {Input, Node2D, Vector2} = require("godot");',
    'exports.default = class Player extends Node2D {',
    '  ' + (camel ? '_physicsProcess' : '_physics_process') + '() {',
    '    if (Input.' + (camel ? 'isActionPressed' : 'is_action_pressed') + '("move_right") &&',
    '        Input.' + (camel ? 'getActionStrength' : 'get_action_strength') + '("move_right") === 1 &&',
    '        Input.' + (camel ? 'getAxis' : 'get_axis') + '("move_left", "move_right") === 1) {',
    '      this.position = new Vector2(this.position.x + 16, this.position.y);',
    '    }',
    '  }',
    '};',
  ].join('\n');
  const project = [
    'config_version=5', '[application]', 'run/main_scene="res://main.tscn"', '[display]',
    'window/size/viewport_width=320', 'window/size/viewport_height=240', '[audio]', 'driver/driver="Dummy"',
    '[rendering]', 'renderer/rendering_method="gl_compatibility"', '[input]',
    'move_left={"deadzone":0.5,"events":[]}', 'move_right={"deadzone":0.5,"events":[Object(InputEventKey,"physical_keycode":4194321)]}',
    '[physics]', 'common/physics_ticks_per_second=' + ticks,
    '[GodotJS]', 'runtime/debugger/debugger_port=0', 'runtime/core/camel_case_bindings_enabled=' + camel,
  ].join('\n') + '\n';
  const onPress = {
    'input-snake': ['if not Input.is_action_pressed("move_right", true) and Input.get_action_strength("move_right", true) == 0 and Input.get_action_raw_strength("move_right") == 0 and not Input.is_action_just_pressed("move_right"):',
      '    print("G0_NATIVE_INPUT_UNCHANGED")'],
    'input-quit': ['get_tree().quit()'],
    'input-replace-action': ['InputMap.erase_action("move_right")', 'InputMap.add_action("move_right")'],
    'input-change-scene': ['get_tree().change_scene_to_file("res://replacement.tscn")'],
    'input-restore-scene': ['var tree = get_tree()', 'var original = tree.current_scene', 'var other = Node.new()',
      'tree.root.add_child(other)', 'tree.current_scene = other', 'var changed = tree.current_scene == other',
      'tree.current_scene = original', 'print("G0_SCENE_RESTORED=", changed and tree.current_scene == original)',
      'print("G0_AFTER_RESTORE=", Input.is_action_pressed("move_right"))', 'other.queue_free()'],
    'input-same-scene': ['get_tree().current_scene = get_tree().current_scene',
      'print("G0_SAME_SCENE_HELD=", Input.is_action_pressed("move_right"))'],
    'input-pause': ['get_tree().paused = true'],
    'input-pause-resume': ['get_tree().paused = true', 'get_tree().paused = false',
      'print("G0_AFTER_RESUME=", Input.is_action_pressed("move_right"))'],
    'input-expiry': ['JavaScriptBridge.eval("{ const stop = performance.now() + 500; while (performance.now() < stop) {} }")',
      'print("G0_AFTER_DEADLINE=", Input.is_action_pressed("move_right"))'],
    'input-release': ['Input.action_release("move_right")'],
    'input-physical': ['var key = InputEventKey.new()', 'key.physical_keycode = KEY_RIGHT', 'key.pressed = true', 'Input.parse_input_event(key)'],
    'input-cancel-no-raf': ['JavaScriptBridge.eval("globalThis.g0PauseAnimation()")', 'print("G0_PAUSED_RAF")'],
  }[mode];
  const main = ['extends Node2D', 'var edge_seen = false', 'var last_step := 0', 'var cadence_seen = false',
    'func _ready():', '    RenderingServer.render_loop_enabled = false', '    last_step = Engine.get_physics_frames()'];
  if (onPress) main.push('func _physics_process(_delta):', '    if not edge_seen and Input.is_action_pressed("move_right"):',
    '        edge_seen = true', ...onPress.map(line => '        ' + line));
  if (mode === 'input-quit-at-release') main.push('func _physics_process(_delta):',
    '    if Input.is_action_pressed("move_right"):', '        edge_seen = true',
    '    elif edge_seen:', '        get_tree().quit()');
  if (ticks !== 60) main.push('func _process(_delta):', '    var count = Engine.get_physics_frames() - last_step',
    '    last_step = Engine.get_physics_frames()', `    if not cadence_seen and count ${ticks < 60 ? '== 0' : '> 1'}:`,
    '        cadence_seen = true', '        print("G0_PHYSICS_CADENCE=", count)');
  if (usesKey) main.push(
    'var key_held := false',
    'func _input(event):',
    '    if event is InputEventKey and event.physical_keycode == KEY_RIGHT:',
    '        key_held = event.pressed',
    '        if not key_held:',
    '            print("G0_KEY_RELEASED")',
    'func _physics_process(_delta):',
    '    if not key_held:',
    '        return',
    '    $Player.position.x += 16',
    '    if not edge_seen:',
    '        edge_seen = true',
    ...(mode === keyCancelMode ? [
      '        JavaScriptBridge.eval("globalThis.g0PauseAnimation(2250)")',
      '        print("G0_PAUSED_RAF")',
    ] : [
      '        get_tree().paused = true',
      '        await get_tree().create_timer(0.4).timeout',
      '        get_tree().paused = false',
      '        print("G0_KEY_RESUMED")',
    ]));
  return new Map(Object.entries({
    'res://project.godot': project,
    'res://main.tscn': '[gd_scene load_steps=3 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[ext_resource type="Script" path="res://Player.ts" id="2"]\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n[node name="Player" type="Node2D" parent="."]\nposition = Vector2(64, 120)\nscript = ExtResource("2")\n',
    'res://main.gd': main.join('\n') + '\n',
    'res://replacement.tscn': '[gd_scene format=3]\n[node name="Replacement" type="Node2D"]\n',
    'res://Player.ts': 'export default class Player {}',
    'res://.godot/GodotJS/Player.js': usesKey
      ? 'exports.default = class Player extends require("godot").Node2D {};'
      : player,
    'res://.godot/global_script_class_cache.cfg': 'list=Array[Dictionary]([])\n',
  }).map(([name, text]) => [name, encoder.encode(text)]));
}

async function verifyInputScripts(page, evidence) {
  for (const mode of inputFixtureModes) {
    const sample = await page.evaluate(async ({mode, keyPauseMode, keyCancelMode}) => {
      const runner = window.probeRunner;
      const run = await window.startProbeFixture(mode), {runId} = run;
      const query = {runId, props: [{path: '/root/Main/Player', property: 'position'}], screenshot: false};
      const read = () => runner.gameProbe(query);
      const before = await read();
      const keyCancel = mode === keyCancelMode;
      const usesKey = mode === keyPauseMode || keyCancel;
      const cancels = mode.startsWith('input-cancel') || mode === 'input-early-cancel' || keyCancel;
      const stops = mode === 'input-stop';
      const expires = mode === 'input-expiry';
      const pressOffset = mode === 'input-early-cancel' ? 119 : mode === 'input-zero' ? 2 : 0;
      const request = {runId, actionName: 'move_right', pressOffset, releaseOffset: cancels || stops || expires ? 120 : pressOffset + 4};
      const controller = new AbortController();
      const wait = () => new Promise(resolve => setTimeout(resolve, 10));
      const onExit = mode.startsWith('input-quit') ? new Promise((resolve, reject) => {
        const timer = setTimeout(() => { unsubscribe(); reject(Error('No native quit receipt')); }, 6000);
        const unsubscribe = runner.subscribe(event => {
          if (event.type === 'exit' && event.report.runId === runId) {
            unsubscribe(); clearTimeout(timer); resolve(event.report);
          }
        });
      }) : null;
      const pending = runner.runGameInputScript(usesKey
        ? {runId, keycode: 4194321, physical: true, pressOffset: 0, releaseOffset: 120}
        : expires ? {...request, timeoutMs: 350} : request, controller.signal);
      let stopping;
      if (mode === 'input-cancel-no-raf' || keyCancel) {
        for (let index = 0; index < 80 && !window.probeLogs.some(log => log.runId === runId && log.text === 'G0_PAUSED_RAF'); index++) await wait();
        if (!window.probeLogs.some(log => log.runId === runId && log.text === 'G0_PAUSED_RAF')) throw Error('No RAF pause evidence');
        controller.abort();
      } else if (mode === 'input-early-cancel') {
        controller.abort();
      } else if (cancels || stops) {
        for (let index = 0; index < 20; index++) {
          const state = await read();
          if (state.ok && state.result.properties[0]?.value.x > 64) break;
        }
        if (stops) stopping = runner.stopRun(runId);
        else controller.abort();
      }
      const input = await pending;
      let retired;
      if (cancels || expires) {
        for (let index = 0; index < 60; index++) {
          retired = await runner.runGameInputScript({...request, actionName: 'missing'});
          if (retired.error?.code !== 'busy') break;
          await wait();
        }
      }
      if (usesKey) {
        for (let index = 0; index < 350; index++) {
          if (window.probeLogs.some(log => log.runId === runId && log.text === 'G0_KEY_RELEASED')) break;
          await wait();
        }
      }
      const after = onExit || stopping ? null : await read();
      const settled = after ? await read() : null;
      const exit = await (onExit ?? stopping ?? runner.stopRun(runId));
      const markers = window.probeLogs.filter(log => log.runId === runId && log.text?.startsWith('G0_')).map(log => log.text);
      return {run, before, input, retired, after, settled, exit, markers};
    }, {mode, keyPauseMode, keyCancelMode});
    evidence.engineExecuted = true;
    if (mode === keyPauseMode || mode === keyCancelMode) {
      if (mode === keyPauseMode) {
        evidence.keyPauseResume = sample;
        assert.equal(sample.input.outcome, 'interrupted');
        assert.equal(sample.input.terminal.reason, 'paused');
        assert.deepEqual(sample.markers, ['G0_KEY_RESUMED', 'G0_KEY_RELEASED']);
      } else {
        evidence.keyCancelWithoutFrames = sample;
        assert.equal(sample.input.outcome, 'outcome_unknown');
        assert.equal(sample.retired.error?.code, 'unknown_action', 'The slot must retire before frames resume');
        assert.deepEqual(sample.markers, ['G0_PAUSED_RAF', 'G0_KEY_RELEASED']);
      }
      const x = sample.after.result.properties[0].value.x;
      if (mode === keyPauseMode) assert.equal(x, 80);
      else assert(x > 64);
      assert.equal(sample.settled.result.properties[0].value.x, x);
      assert.equal(sample.exit.hostCleanup.status, 'complete');
      continue;
    }
    evidence.cases.push({name: mode, ...sample});
    verifyInputScriptCase(evidence.cases.at(-1));
  }
}

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
    runtimeWorker: asset('runtime.worker.js', await bundle(`
      import {installWorkerRuntime} from '@godot-js/engine/browser/dedicated/worker-runtime';
      ${inputOnly ? `globalThis.g0PauseAnimation = (delay = 600) => {
        const schedule = globalThis.requestAnimationFrame.bind(globalThis);
        globalThis.requestAnimationFrame = callback => { setTimeout(() => schedule(callback), delay); return 0; };
        setTimeout(() => { globalThis.requestAnimationFrame = schedule; }, delay - 50);
      };` : ''}
      installWorkerRuntime();`)),
    runtimeAudioWorklet: asset('runtime.audio.worklet.js', await bundle('import "../../packages/engine/src/browser/dedicated/worker-audio-worklet.ts";')),
  };
  release.releaseId = hash(JSON.stringify({engine: [release.engineJs.sha256, release.engineWasm.sha256],
    host: [release.runtimeWorker.sha256, release.runtimeAudioWorklet.sha256], abi: release.runtimeAbi}));
  evidence.releaseId = release.releaseId;
  const artifacts = {};
  const modes = inputOnly ? inputFixtureModes :
    ['live', 'paused-render', 'manual', 'pre-force', 'post-force', 'non-root', 'direct-to-screen', 'quit'];
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
  if (inputOnly) await verifyInputScripts(page, evidence);
  else {
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
  }
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
  await writeFile(path.join(out, inputOnly ? 'input-script-g0.json' : 'game-probe-g0.json'), JSON.stringify(evidence, null, 2) + '\n');
}

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile, lstat, mkdir, open, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {operationResult, checkUnknownAction, checkProbeImageFrame, parseProbePosition} from './summer-native-receipt.mjs';

const fixture = new URL('./fixtures/summer-compat/', import.meta.url);
const caseFile = new URL('./fixtures/summer-input-cases.json', import.meta.url);
const toolkit = '4.9.2';
const scene = 'res://main.tscn';
const positionKey = '/root/Main/Player:position';
const initialPosition = {x: 64, y: 256};
const movedPosition = {x: 128, y: 256};
const fixtureFiles = ['project.godot', 'main.tscn', 'player.gd'];
const traceName = /^godotai-summer-[1-9][0-9]*-[a-f0-9]{24}\.jsonl$/;
const probeFrameFields = ['process_frames', 'physics_frames', 'frames_drawn'];
const timeoutMs = 90_000;

const {values: options} = parseArgs({options: {
  out: {type: 'string'}, project: {type: 'string'}, cli: {type: 'string'},
  binary: {type: 'string'}, 'instance-id': {type: 'string'}, 'trace-dir': {type: 'string'},
  'editor-version': {type: 'string', default: '0.8.8'}, 'state-dir': {type: 'string'},
  'process-probe': {type: 'string'}, 'runner-label': {type: 'string'},
  'smoke-only': {type: 'boolean'}, help: {type: 'boolean'},
}});
if (options.help) {
  console.log('Usage: node collect-summer-native.mjs --out NEW_DIR --project FIXTURE_COPY --cli SUMMER_JS --binary EDITOR --instance-id ID --trace-dir DIR [--smoke-only]');
  process.exit(0);
}
assert(options.out, 'Supply a new evidence directory with --out');
const output = path.resolve(options.out);
await mkdir(path.dirname(output), {recursive: true});
await mkdir(output);
await mkdir(path.join(output, 'calls'));

const detailCases = ['notRunning', 'unknownAction', 'holdMillisecondsDefault', 'holdMillisecondsFixed'];
const requiredCases = options['smoke-only'] ? ['frameOffsets'] : ['frameOffsets', ...detailCases];
const report = {
  kind: 'godotai-summer-native-input-evidence',
  schemaVersion: 1,
  status: 'blocked',
  stage: 'preflight',
  host: {platform: process.platform, arch: process.arch, node: process.version},
  toolkit: {version: toolkit, commit: '5d0bc70c6228a2f718485913449f20482434b47b'},
  expectedEditorVersion: options['editor-version'],
  mode: options['smoke-only'] ? 'smoke-only' : 'full',
  requiredCases,
  cases: Object.fromEntries(['frameOffsets', ...detailCases, 'interruption'].map(name => [name, {status: 'not_run'}])),
  calls: [],
  images: [],
  runs: [],
  prerequisites: [],
  cleanupErrors: [],
};
report.cases.interruption.reason = 'No cancellation or freeze is performed by this collector';
if (options['smoke-only']) {
  for (const name of detailCases) report.cases[name].reason = 'Skipped by --smoke-only';
}
let cli, project, traceDir, editor, env, currentRun;

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Summer saves its project metadata on first open and omits settings at their
// Godot defaults. Compare the behavior-bearing settings after that rewrite.
function fixtureSettings(text) {
  const settings = {};
  let section = '', key;
  for (const line of text.split(/\r?\n/).map(value => value.trim())) {
    if (!line || line.startsWith(';')) continue;
    const header = line.match(/^\[([a-z]+)\]$/);
    if (header) {
      section = header[1] + '/';
      key = undefined;
      continue;
    }
    const assignment = line.match(/^([\w/]+)=(.*)$/);
    if (assignment) {
      key = section + assignment[1];
      assert(!Object.hasOwn(settings, key), 'Duplicate fixture setting: ' + key);
      settings[key] = assignment[2];
    } else {
      assert(key, 'Unexpected fixture project setting continuation');
      settings[key] += '\n' + line;
    }
  }
  const editorMetadata = {
    features: settings['application/config/features'],
    version: settings['summer/version'],
    assemblyName: settings['dotnet/project/assembly_name'],
  };
  delete settings['application/config/features'];
  delete settings['summer/version'];
  if (editorMetadata.assemblyName === settings['application/config/name']) delete settings['dotnet/project/assembly_name'];
  settings['physics/common/physics_ticks_per_second'] ??= '60';
  settings['physics/common/physics_interpolation'] ??= 'false';
  return {settings, editorMetadata};
}

function fixtureScene(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && line !== 'color = Color(1, 1, 1, 1)')
    .map(line => {
      if (line.startsWith('[gd_scene ')) return line.replace(/ load_steps=\d+/g, '').replace(/ uid="uid:\/\/[a-z0-9]+"/g, '');
      if (line.startsWith('[ext_resource ')) return line.replace(/ uid="uid:\/\/[a-z0-9]+"/g, '');
      if (line.startsWith('[node ')) return line.replace(/ unique_id=\d+/g, '');
      return line;
    });
}

async function inspectFixture(stage) {
  const observations = {};
  report[stage] = observations;
  for (const file of fixtureFiles) {
    const source = new URL(file, fixture);
    const actual = path.join(project, file);
    const sourceSha256 = await sha256(source);
    const actualSha256 = await sha256(actual);
    const observation = observations[file] = {sourceSha256, actualSha256};
    if (file === 'project.godot') {
      const native = fixtureSettings(await readFile(actual, 'utf8'));
      observation.editorMetadata = native.editorMetadata;
      await copyFile(actual, path.join(output, stage + '.project.godot'));
      assert.deepEqual(native.settings, fixtureSettings(await readFile(source, 'utf8')).settings,
        'Summer changed behavior-bearing fixture project settings');
    } else if (file === 'main.tscn') {
      await copyFile(actual, path.join(output, stage + '.main.tscn'));
      assert.deepEqual(fixtureScene(await readFile(actual, 'utf8')), fixtureScene(await readFile(source, 'utf8')),
        'Summer changed behavior-bearing fixture scene data');
    } else {
      assert.equal(actualSha256, sourceSha256, 'Fixture differs from the repository copy: ' + file);
    }
  }
}

async function command(executable, args, name, processOptions = {}) {
  const stem = 'calls/' + String(report.calls.length + 1).padStart(3, '0') + '-' + name;
  const call = {name, args, stdout: stem + '.stdout', stderr: stem + '.stderr'};
  report.calls.push(call);
  const stdout = await open(path.join(output, call.stdout), 'wx');
  let stderr, timer;
  try {
    stderr = await open(path.join(output, call.stderr), 'wx');
    const child = spawn(executable, args, {stdio: ['ignore', stdout.fd, stderr.fd], windowsHide: true, ...processOptions});
    timer = setTimeout(() => {
      call.timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({code, signal}));
    });
    Object.assign(call, exit);
    assert(!call.timedOut, name + ' timed out at the collector; the engine outcome is unknown');
    return call;
  } catch (error) {
    call.error = error.message;
    throw error;
  } finally {
    clearTimeout(timer);
    await Promise.all([stdout.close(), stderr?.close()]);
  }
}

async function operation(name, input, {failure = false} = {}) {
  const call = await command(process.execPath, [cli, 'engine', name, '--input', JSON.stringify(input), '--json'],
    name, {cwd: project, env});
  const stream = call.code === 0 ? call.stdout : call.stderr;
  let answer;
  try {
    answer = JSON.parse(await readFile(path.join(output, stream), 'utf8'));
  } catch {
    throw Error(name + ' did not produce one JSON response. See ' + stream);
  }
  assert(failure ? call.code === 1 && answer.ok === false : call.code === 0 && answer.ok === true && answer.status === 'done',
    name + ' returned an unexpected outcome. See ' + stream);
  return {answer, call: stream};
}

async function context() {
  return (await operation('get-project-context', {include: ['capabilities']})).answer.result;
}

function assertEditorIdentity(observed) {
  assert.equal(observed.health?.instanceId, editor.health.instanceId, 'Editor instance changed');
  assert.equal(observed.health?.projectIdHash, editor.health.projectIdHash, 'Editor project identity changed');
  assert.equal(observed.health?.pid, editor.health.pid, 'Editor PID changed');
  assert.equal(observed.mainScene, scene, 'Editor main scene changed');
  assert.equal(observed.boundProjectIdHash, editor.health.projectIdHash, 'The CLI did not retain the editor project binding');
}

async function processBinary(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'Missing native process PID');
  if (process.platform === 'linux') return realpath('/proc/' + pid + '/exe');
  const windows = process.platform === 'win32';
  const call = report.host.processProbe
    ? await command(report.host.processProbe.path, [String(pid)], 'process-binary')
    : windows
    ? await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-Process -Id " + pid + ' -ErrorAction Stop).Path'], 'process-binary')
    : await command('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm='], 'process-binary');
  assert.equal(call.code, 0, 'Could not determine executable for native PID ' + pid);
  return realpath((await readFile(path.join(output, call.stdout), 'utf8')).trim());
}

async function editorVersion(binary, health) {
  if (process.platform === 'darwin') {
    const plist = path.join(path.dirname(binary), '..', 'Info.plist');
    const call = await command('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], 'editor-version');
    assert.equal(call.code, 0, 'Could not read the installed Summer app version');
    return (await readFile(path.join(output, call.stdout), 'utf8')).trim();
  }
  if (process.platform === 'win32') {
    const version = await readFile(path.join(path.dirname(binary), 'sq.version'), 'utf8');
    return version.match(/<version>\s*([^<]+?)\s*<\/version>/)?.[1];
  }
  return health.version?.replace(/^v/, '');
}

async function gameInstances() {
  const {answer} = await operation('game-control', {action: 'instances'});
  const {instances} = operationResult(answer, 'ListGameInstances');
  assert(Array.isArray(instances), 'Missing game instance list');
  return instances;
}

async function sameGame(run) {
  // Every command uses a fresh CLI with both the editor ID and project path
  // pinned. Read the game identity without asking the editor to rebind again.
  const live = (await gameInstances()).find(item => item.name === run.instance.name);
  assert(live?.attached === true && live.pid === run.instance.pid && live.scene === run.instance.scene,
    'The bound game instance was replaced, changed scene, or detached');
}

async function readTrace(file) {
  const info = await lstat(file);
  assert(info.isFile() && info.size <= 64 * 1024, 'Invalid or oversized fixture trace: ' + file);
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.pop(); // A concurrent partial append is not evidence.
  return lines.map(line => JSON.parse(line));
}

async function until(get, message, wait = 15_000) {
  const deadline = Date.now() + wait;
  do {
    const value = await get();
    if (value) return value;
    await delay(200);
  } while (Date.now() < deadline);
  throw Error(message);
}

async function startGame(name, settings = {}) {
  assertEditorIdentity(await context());
  assert.deepEqual(await gameInstances(), [], 'The disposable fixture already has a running game');
  const priorFiles = new Set(await readdir(traceDir));
  const played = await operation('play', {scene, instance: 'main', focus: true, ...settings});
  const play = operationResult(played.answer, 'PlayGame');
  const instance = await until(async () => {
    const main = (await gameInstances()).find(item => item.name === 'main' && item.attached === true);
    if (main) {
      assert.equal(main.scene, scene);
      assert(Number.isSafeInteger(main.pid) && main.pid > 0);
      return main;
    }
  }, 'No attached main fixture game appeared');
  if (play.runtimeFreshness?.pid !== undefined) assert.equal(play.runtimeFreshness.pid, instance.pid);
  const run = {name, instance, play: played.call, launchId: play.launchId};
  // Claim the game for cleanup only after observing its own fixture startup.
  const observed = await until(async () => {
    for (const entry of await readdir(traceDir)) {
      if (priorFiles.has(entry) || !traceName.test(entry)) continue;
      const file = path.join(traceDir, entry);
      const [ready] = await readTrace(file);
      if (ready?.schemaVersion === 1 && ready.edge === 'ready' && ready.pid === instance.pid &&
          ready.fixture === 'godotai-summer-input' && entry === 'godotai-summer-' + ready.runId + '.jsonl') {
        return {file, ready};
      }
    }
  }, 'No fresh fixture trace appeared for the attached game PID; check GODOTAI_SUMMER_TRACE_DIR');
  run.runId = observed.ready.runId;
  run.tracePath = observed.file;
  run.ready = observed.ready;
  currentRun = run;
  report.runs.push(run);
  assert.equal(observed.ready.physicsTicksPerSecond, 60);
  assert.equal(observed.ready.physicsInterpolation, false);
  assert.deepEqual(observed.ready.position, initialPosition);
  assert.equal(observed.ready.timeScale, 1);
  const binary = await processBinary(instance.pid);
  run.binary = {path: binary, sha256: binary === report.editor.binary.path ? report.editor.binary.sha256 : await sha256(binary)};
  if (settings.fixed_fps !== undefined) {
    const {determinism} = play;
    const flag = determinism?.args?.indexOf('--fixed-fps') ?? -1;
    run.cadence = {requestedFixedFps: settings.fixed_fps, determinism, listedFixedFps: instance.fixed_fps,
      playPid: play.runtimeFreshness?.pid};
    assert(determinism?.applied === true && determinism.fixed_fps === settings.fixed_fps &&
      flag >= 0 && determinism.args[flag + 1] === String(settings.fixed_fps) && !determinism.conflicting_flag &&
      play.runtimeFreshness?.pid === instance.pid && (instance.fixed_fps ?? settings.fixed_fps) === settings.fixed_fps,
    'Summer did not confirm that fixed_fps applied to this game');
  }
  return run;
}

async function stopGame(run) {
  const live = await gameInstances();
  if (live.some(item => item.name === run.instance.name)) {
    await sameGame(run);
    const stopped = await operation('stop', {instance: run.instance.name});
    operationResult(stopped.answer, 'StopGame');
    run.stop = stopped.call;
    await until(async () => !(await gameInstances()).some(item => item.name === run.instance.name),
      'No stopped-game evidence arrived');
  }
  if (currentRun === run) currentRun = undefined;
  run.trace = run.name + '.jsonl';
  await copyFile(run.tracePath, path.join(output, run.trace));
}

async function capture(run, label, expected) {
  await sameGame(run);
  const {answer, call} = await operation('game-probe', {instance: run.instance.name,
    props: [positionKey], screenshot: true, max_dim: 512});
  const sample = operationResult(answer, 'GameProbe');
  assert(typeof answer.result.image_path === 'string' && path.isAbsolute(answer.result.image_path), 'Missing original GameProbe image');
  const imageInfo = await lstat(answer.result.image_path);
  assert(imageInfo.isFile() && imageInfo.size <= 8 * 1024 * 1024, 'Invalid or oversized GameProbe image');
  const image = await readFile(answer.result.image_path);
  const png = image.length > 8 && image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = image.length > 4 && image[0] === 0xff && image[1] === 0xd8 && image.at(-2) === 0xff && image.at(-1) === 0xd9;
  assert(png || jpeg, 'GameProbe image is not a recognized PNG or JPEG');
  const file = label + (png ? '.png' : '.jpg');
  await writeFile(path.join(output, file), image, {flag: 'wx'});
  const evidence = {file, call, runId: run.runId, frame: sample.frame, imageFrame: sample.image_frame,
    rawPosition: sample.values?.[positionKey], mime: png ? 'image/png' : 'image/jpeg', width: sample.width,
    height: sample.height, bytes: image.length, sha256: createHash('sha256').update(image).digest('hex')};
  report.images.push(evidence);
  evidence.position = parseProbePosition(evidence.rawPosition);
  assert.deepEqual(evidence.position, expected);
  for (const field of probeFrameFields) {
    assert(Number.isSafeInteger(sample.frame?.[field]) && sample.frame[field] >= 0, 'Missing native frame field ' + field);
  }
  checkProbeImageFrame(sample);
  await sameGame(run);
  return sample.frame;
}

async function captureInput(run, input, action) {
  await sameGame(run);
  const {answer, call} = await operation('game-input', input);
  const receipt = operationResult(answer, 'SimulateInputScript');
  const edges = await until(async () => {
    const trace = await readTrace(run.tracePath);
    assert(trace.every(row => row.runId === run.runId && row.pid === run.instance.pid), 'Fixture trace identity changed');
    const matching = trace.filter(row => row.action === action);
    if (matching.some(row => row.edge === 'released')) return matching;
  }, 'The fixture did not observe the action release');
  assert.deepEqual(edges.map(row => row.edge), ['pressed', 'released']);
  assert(edges[1].heldTicks > 0 && edges[1].physicsFrame > edges[0].physicsFrame,
    'Fixture edge trace does not show a held action');
  assert.equal(receipt.completed, true, 'Summer did not complete the submitted input. See ' + call);
  assert.equal(receipt.applied, input.events.length, 'Unexpected applied event count. See ' + call);
  assert.deepEqual(receipt.rejected, [], 'Summer rejected input events. See ' + call);
  await sameGame(run);
  return {call, runId: run.runId, receipt, pressed: edges[0], released: edges[1]};
}

async function exerciseCase(name, perform) {
  process.stderr.write('[summer-native-input] ' + name + '\n');
  try {
    report.cases[name] = {status: 'passed', ...await perform()};
  } catch (error) {
    report.cases[name] = {status: 'failed', error: error.message};
  }
}

try {
  const missing = ['project', 'cli', 'binary', 'instance-id', 'trace-dir'].filter(key => !options[key]);
  report.prerequisites = missing.map(key => 'Supply --' + key + ' for a running, verified Summer editor');
  assert.equal(missing.length, 0, 'A verified Summer native host is required. Missing options: ' + missing.join(', '));
  cli = await realpath(options.cli);
  project = await realpath(options.project);
  traceDir = await realpath(options['trace-dir']);
  assert.notEqual(project, await realpath(fileURLToPath(fixture)), 'Use a disposable copy of the fixture');
  const binary = await realpath(options.binary);
  if (options['runner-label']) report.host.runnerLabel = options['runner-label'];
  if (options['process-probe']) {
    assert.equal(process.platform, 'win32', '--process-probe is for Windows hosts without PowerShell');
    const executable = await realpath(options['process-probe']);
    report.host.processProbe = {path: executable, sha256: await sha256(executable)};
  }
  env = {...process.env, SUMMER_ENGINE_PROJECT: project, SUMMER_ENGINE_INSTANCE_ID: options['instance-id'],
    SUMMER_NO_TELEMETRY: '1'};
  if (options['state-dir']) env.SUMMER_ENGINE_STATE_DIR = await realpath(options['state-dir']);
  assert.notEqual(env.SUMMER_SURFACE, 'v3', 'Use the public Summer v4 CLI surface');
  const pkg = JSON.parse(await readFile(path.resolve(path.dirname(cli), '../../package.json'), 'utf8'));
  assert(pkg.name === 'summer-engine' && pkg.version === toolkit, 'Expected the pinned public summer-engine toolkit');
  const versionCall = await command(process.execPath, [cli, '--version'], 'toolkit-version', {cwd: project, env});
  assert.equal(versionCall.code, 0);
  assert.equal((await readFile(path.join(output, versionCall.stdout), 'utf8')).trim().replace(/^v/, ''), toolkit);
  report.toolkit.cliSha256 = await sha256(cli);
  await inspectFixture('fixtureBefore');
  const inputs = JSON.parse(await readFile(caseFile, 'utf8'));
  for (const [name, input] of Object.entries(inputs)) {
    await writeFile(path.join(output, name + '.input.json'), JSON.stringify(input, null, 2) + '\n');
  }
  editor = await context();
  assert.equal(await realpath(editor.projectPath), project, 'Editor returned a different project path');
  assert.equal(editor.health?.engine, 'summer', 'Editor did not identify itself as Summer');
  assert.equal(editor.health?.instanceId, options['instance-id']);
  assert(editor.health?.projectIdHash, 'Editor did not provide the project binding hash');
  assertEditorIdentity(editor);
  const caps = editor.health.capabilities;
  const operations = new Set([...(caps?.opKinds ?? []), ...(caps?.runtimeControl?.ops ?? [])]);
  for (const op of ['SimulateInputScript', 'GameProbe', 'ListGameInstances']) assert(operations.has(op), 'Missing Summer capability: ' + op);
  assert.equal(await processBinary(editor.health.pid), binary, 'The bound editor process uses a different executable');
  const version = await editorVersion(binary, editor.health);
  assert.equal(version, options['editor-version'], 'Installed editor does not match the expected native version');
  report.editor = {version, binary: {path: binary, sha256: await sha256(binary)}, project,
    instanceId: editor.health.instanceId, projectIdHash: editor.health.projectIdHash, pid: editor.health.pid};
  assert.deepEqual(await gameInstances(), [], 'Close any existing game in the disposable fixture first');
  report.stage = 'run';
  report.status = 'failed';
  await exerciseCase('frameOffsets', async () => {
    const run = await startGame('explicit-edges');
    await capture(run, 'before', initialPosition);
    const input = await captureInput(run, inputs.frameOffsets, 'move_right');
    const frameDelta = input.released.physicsFrame - input.pressed.physicsFrame;
    const matches = frameDelta === 4 && input.released.heldTicks === 4;
    if (matches) assert.deepEqual(input.released.position, movedPosition, 'Movement did not match four held physics ticks');
    const frame = await capture(run, 'after', input.released.position);
    assert(frame.physics_frames >= input.released.physicsFrame, 'The post-input probe predates the observed release');
    await stopGame(run);
    const restart = await startGame('restart');
    assert.notEqual(restart.runId, run.runId, 'Restart reused the previous game');
    await capture(restart, 'restart', initialPosition);
    return {status: matches ? 'passed' : 'difference', ...input, frameDelta, restartRunId: restart.runId,
      ...(!matches && {reason: 'The observed physics frame delta or held tick count differs from four'})};
  });
  const collectDetails = ['passed', 'difference'].includes(report.cases.frameOffsets.status) && !options['smoke-only'];
  if (!collectDetails && !options['smoke-only']) {
    for (const name of detailCases) report.cases[name].reason = 'Requires a completed frameOffsets comparison';
  }
  if (collectDetails) {
    await exerciseCase('unknownAction', async () => {
      const run = currentRun;
      await sameGame(run);
      const {answer, call} = await operation('game-input', inputs.unknownAction, {failure: true});
      const receipt = operationResult(answer, 'SimulateInputScript', false);
      checkUnknownAction(receipt, inputs.unknownAction.events);
      await sameGame(run);
      const trace = await readTrace(run.tracePath);
      assert.deepEqual(trace.map(row => row.edge), ['ready'], 'Rejected action changed the fixture edge trace');
      return {call, runId: run.runId, receipt};
    });
    await exerciseCase('holdMillisecondsDefault', () => captureInput(currentRun, inputs.holdMilliseconds, 'jump'));
  }
  if (currentRun) await stopGame(currentRun);
  if (collectDetails) {
    await exerciseCase('notRunning', async () => {
      assert.deepEqual(await gameInstances(), []);
      const {answer, call} = await operation('game-input', inputs.frameOffsets, {failure: true});
      const receipt = operationResult(answer, 'SimulateInputScript', false);
      assert.equal(receipt.failure_reason, 'game_not_running', 'Expected native game_not_running evidence. See ' + call);
      assertEditorIdentity(await context());
      assert.deepEqual(await gameInstances(), []);
      return {call, receipt};
    });
    await exerciseCase('holdMillisecondsFixed', async () => {
      const run = await startGame('fixed-hold', {fixed_fps: 60});
      const input = await captureInput(run, inputs.holdMilliseconds, 'jump');
      await stopGame(run);
      return input;
    });
  }
  await inspectFixture('fixtureAfter');
  const incomplete = requiredCases.filter(name => !['passed', 'difference'].includes(report.cases[name].status));
  if (incomplete.length) {
    report.error = 'Required cases incomplete: ' + incomplete.join(', ');
  } else {
    report.status = requiredCases.some(name => report.cases[name].status === 'difference') ? 'difference' : 'passed';
  }
} catch (error) {
  report.error = error.message;
} finally {
  if (currentRun) {
    try { await stopGame(currentRun); }
    catch (error) { report.cleanupErrors.push(error.message); }
  }
  if (report.cleanupErrors.length && report.stage === 'run') report.status = 'failed';
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({status: report.status, report: path.join(output, 'report.json')}) + '\n');
  if (report.status !== 'passed') process.exitCode = 1;
}

import type {GameScreenshot} from '@godot-js/engine/browser/dedicated/worker-runner';
import type {PlaygroundApi, PlaygroundApiCall, createPlaygroundApi} from '../playground-api';
import {INTERACTION_DEMO_PLAYER} from '../interaction-demo';

interface PlaytestActions {
  unavailable(): string | undefined;
  supportsRuntimeObservation(): boolean;
  open(): Promise<string>;
  cancelLaunch(attemptId: string): void;
}

type CapturedPng = {png: Blob; frame: GameScreenshot};

async function readPixels(png: Blob, points: readonly (readonly [number, number])[]) {
  const image = await createImageBitmap(png);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = points.length;
    canvas.height = 1;
    const context = canvas.getContext('2d')!;
    points.forEach(([x, y], index) => context.drawImage(image, x, y, 1, 1, index, 0, 1, 1));
    const colors = context.getImageData(0, 0, points.length, 1).data;
    return points.map((_, index) => colors.slice(index * 4, index * 4 + 4));
  } finally { image.close(); }
}

function matchesColor(color: Uint8ClampedArray, red: number, green: number, blue: number) {
  return color[0] === red && color[1] === green && color[2] === blue && color[3] === 255;
}

function untilDeadline(message: string) {
  const deadline = performance.now() + 5000;
  return () => {
    const milliseconds = Math.ceil(deadline - performance.now());
    if (milliseconds < 1) throw Error(message);
    return milliseconds;
  };
}

async function collectPlaytest(api: PlaygroundApi, runId: string, signal: AbortSignal, status: HTMLElement, observePlayer: boolean) {
  const capture = async (timeoutMs = 5000): Promise<CapturedPng> => {
    const result = await api.screenshot({runId, timeoutMs}, signal);
    if (!result.ok) throw Error(result.error.message);
    const frame = result.result;
    return {png: new Blob([frame.bytes], {type: frame.mimeType}), frame};
  };
  const tap = async (code: 'Space' | 'ArrowRight') => {
    const input = api.game_input({runId, gesture: {kind: 'key_tap', code}});
    if (!input.ok) throw Error(input.error.message);
    const receipt = await api.wait_for_input({runId, operationId: input.result.operationId}, signal);
    if (!receipt.ok || receipt.result.operation.status !== 'dispatched') throw Error(`${code} 的按下和释放未全部确认分发`);
  };

  if (!observePlayer) {
    const readCenter = async ({png, frame}: CapturedPng) => (await readPixels(png, [[frame.width >> 1, frame.height >> 1]]))[0];
    status.textContent = '正在采集输入前画面';
    const before = await capture();
    if (!matchesColor(await readCenter(before), 255, 0, 0)) throw Error('输入前画面未显示示例的红色背景');
    await tap('Space');
    status.textContent = '正在观察输入后画面';
    const remaining = untilDeadline('未观察到示例的绿色背景');
    let after: CapturedPng;
    do { after = await capture(remaining()); } while (!matchesColor(await readCenter(after), 0, 255, 0));
    return [{caption: '输入前', png: before.png}, {caption: '输入后', png: after.png}];
  }

  const {name, startX, endX, y, viewportWidth, viewportHeight} = INTERACTION_DEMO_PLAYER;
  status.textContent = '正在读取运行时节点';
  const tree = await api.get_runtime_tree({runId, depth: 3}, signal);
  if (!tree.ok) throw Error(tree.error.message);
  const player = tree.result.nodes.find(node => node.name === name && node.type === 'Node2D');
  if (!player) throw Error('运行时节点树中没有 Player');
  const inspect = async (timeoutMs = 5000) => {
    const snapshot = await api.inspect_runtime_node({runId, path: player.path, properties: ['position'], timeoutMs}, signal);
    if (!snapshot.ok) throw Error(snapshot.error.message);
    const position = snapshot.result.properties.find(property => property.name === 'position');
    if (!position || !('value' in position) || typeof position.value !== 'object') throw Error('无法读取 Player 的 position');
    if (snapshot.result.node.instanceId !== player.instanceId) throw Error('Player 实例已经更换');
    return {sampleSeq: snapshot.result.sampleSeq, position: position.value};
  };
  const readMarker = ({png, frame}: CapturedPng) => {
    const pngCoordinate = (coordinate: number, viewport: number, source: number, output: number) => {
      const sourceCoordinate = coordinate * source / viewport;
      return Math.floor(sourceCoordinate * (output / source));
    };
    const py = pngCoordinate(y, viewportHeight, frame.sourceHeight, frame.height);
    return readPixels(png, [startX, endX].map(x => [pngCoordinate(x, viewportWidth, frame.sourceWidth, frame.width), py]));
  };
  const red = (color: Uint8ClampedArray) => matchesColor(color, 255, 0, 0);
  const white = (color: Uint8ClampedArray) => matchesColor(color, 255, 255, 255);

  const initial = await inspect();
  if (initial.position.x !== startX || initial.position.y !== y) throw Error('Player 初始位置与示例不符');
  status.textContent = '正在采集输入前画面';
  const before = await capture();
  const [oldPixel, newPixel] = await readMarker(before);
  if (!white(oldPixel) || !red(newPixel)) throw Error('输入前画面未显示白色色块位于 Player 初始位置');

  await tap('ArrowRight');
  status.textContent = '正在验证 Player 的位置和画面';
  const remaining = untilDeadline('未观察到 Player 完成移动');
  let moved = await inspect(remaining());
  while (moved.position.x !== endX || moved.position.y !== y) moved = await inspect(remaining());
  if (moved.sampleSeq <= initial.sampleSeq) throw Error('Player 位置采样没有更新');
  let after: CapturedPng;
  for (;;) {
    after = await capture(remaining());
    const [oldPixel, newPixel] = await readMarker(after);
    if (red(oldPixel) && white(newPixel) && after.frame.renderSerial > before.frame.renderSerial) break;
  }
  const frames = [['输入前', before, initial], ['输入后', after, moved]] as const;
  return frames.map(([label, frame, sample]) => ({
    caption: `${label} · Player x=${sample.position.x} · 状态 #${sample.sampleSeq} · 画面 #${frame.frame.renderSerial}`,
    png: frame.png,
  }));
}

export function createAgentPanel(playground: ReturnType<typeof createPlaygroundApi>, demo?: PlaytestActions) {
  const run = document.getElementById('agent-replay') as HTMLButtonElement;
  const stop = document.getElementById('agent-stop') as HTMLButtonElement;
  const status = document.getElementById('agent-status')!;
  const trace = document.getElementById('agent-trace')!;
  const testPlay = document.getElementById('agent-playtest') as HTMLButtonElement | null;
  const images = document.getElementById('agent-observations');
  const {api} = playground;
  let runId: string | undefined;
  let replayWait: AbortController | undefined;
  const calls: string[] = [];
  const imageUrls: string[] = [];
  let playtest: AbortController | undefined;
  const clearImages = () => {
    for (const url of imageUrls.splice(0)) URL.revokeObjectURL(url);
    images?.replaceChildren();
    if (images) images.hidden = true;
  };
  addEventListener('pagehide', () => { playtest?.abort(); clearImages(); });

  function show(call: PlaygroundApiCall) {
    const body = JSON.stringify(call, null, 2);
    calls.push(body.length > 16_384 ? body.slice(0, 16_384) + '\n…显示已截断' : body);
    if (calls.length > 12) calls.shift();
    trace.textContent = calls.join('\n\n');
    trace.hidden = false;
  }
  playground.subscribe(show);

  run.onclick = async () => {
    if (playtest) return;
    replayWait?.abort();
    const controller = new AbortController();
    replayWait = controller;
    run.disabled = stop.disabled = true;
    runId = undefined;
    calls.length = 0;
    trace.textContent = '';
    trace.hidden = true;
    clearImages();
    status.textContent = '正在检查项目';
    try {
      const {projectId, editorRevision} = api.get_project_context().result;
      if (projectId === null || editorRevision === null) {
        status.textContent = '当前项目尚未就绪';
        return;
      }
      const input = {projectId, expectedEditorRevision: editorRevision};
      const check = await api.check(input);
      if (!check.ok || check.result.status === 'failed') {
        status.textContent = check.ok ? check.result.error?.diagnostic.message ?? '检查失败' : check.error.message;
        return;
      }
      api.get_diagnostics({projectId, editorRevision, checkId: check.result.checkId});
      if (check.result.diagnostics.counts?.error) {
        status.textContent = '检查发现错误，请查看诊断';
        return;
      }
      const play = api.play(input);
      if (!play.ok) { status.textContent = play.error.message; return; }
      const {attemptId} = play.result;
      status.textContent = '正在构建并启动预览';
      for (;;) {
        const observed = await api.wait_for_event({attemptId, until: 'running'}, controller.signal);
        if (controller.signal.aborted) return;
        if (!observed.ok) { status.textContent = observed.error.message; return; }
        api.get_build({attemptId});
        const {run: session, outcome} = observed.result;
        runId = session?.runId;
        if (runId) api.read_run_events({runId, kinds: ['log'], limit: 20});
        stop.disabled = !runId || session?.exit !== undefined;
        if (outcome !== 'timeout') {
          status.textContent = outcome === 'reached' ? '预览已启动' : '本次预览未进入运行状态';
          return;
        }
        status.textContent = '等待超时，仍在跟踪本次预览';
        run.disabled = false;
      }
    } finally {
      if (replayWait === controller) {
        replayWait = undefined;
        run.disabled = false;
      }
    }
  };

  stop.onclick = async () => {
    if (!runId) return;
    const target = runId;
    const previousWait = replayWait;
    replayWait = undefined;
    previousWait?.abort();
    stop.disabled = run.disabled = true;
    try {
      const stopped = api.stop({runId: target});
      if (!stopped.ok) { status.textContent = stopped.error.message; return; }
      status.textContent = '正在等待退出回执';
      const result = await api.wait_for_event({runId: target, until: 'exited'});
      status.textContent = !result.ok ? result.error.message :
        result.result.run?.exit?.evidence === 'host-report' ? '已取得退出回执' :
        result.result.run?.exit ? '编辑器已关闭预览，未收到退出回执' : '等待退出超时，可继续查看运行记录';
      if (result.ok && result.result.outcome === 'timeout') stop.disabled = false;
    } finally {
      run.disabled = false;
    }
  };

  if (testPlay && images && demo) {
    testPlay.hidden = false;
    testPlay.onclick = async () => {
      const unavailable = demo.unavailable();
      if (unavailable) { status.textContent = unavailable; return; }
      const controller = new AbortController();
      playtest = controller;
      const previousWait = replayWait;
      replayWait = undefined;
      previousWait?.abort();
      testPlay.disabled = run.disabled = stop.disabled = true;
      calls.length = 0;
      trace.replaceChildren();
      trace.hidden = true;
      clearImages();
      let attemptId: string | undefined;
      let target: string | undefined;
      let failure: string | undefined;
      let exitStatus = '已验证画面变化，退出尚未确认';
      try {
        status.textContent = '正在打开试玩示例';
        const demoId = await demo.open();
        if (controller.signal.aborted) return;
        const context = api.get_project_context().result;
        if (context.projectId !== demoId || context.editorRevision === null) throw Error('试玩项目已切换');
        const played = api.play({projectId: demoId, expectedEditorRevision: context.editorRevision});
        if (!played.ok) throw Error(played.error.message);
        attemptId = played.result.attemptId;
        status.textContent = '正在启动试玩示例';
        const ready = await api.wait_for_event({attemptId, until: 'running'}, controller.signal);
        target = ready.ok ? ready.result.run?.runId : undefined;
        if (!ready.ok || ready.result.outcome !== 'reached' || !target) throw Error('试玩示例未进入运行状态');
        const samples = await collectPlaytest(api, target, controller.signal, status, demo.supportsRuntimeObservation());
        for (const sample of samples) {
          const figure = document.createElement('figure'), caption = document.createElement('figcaption');
          const image = document.createElement('img'), url = URL.createObjectURL(sample.png);
          imageUrls.push(url);
          caption.textContent = sample.caption;
          image.alt = sample.caption + '的游戏画面'; image.src = url;
          figure.append(caption, image); images.append(figure);
        }
        images.hidden = false;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        if (!target && attemptId) {
          demo.cancelLaunch(attemptId);
          const build = api.get_build({attemptId});
          if (build.ok && build.result.preview?.status === 'session-created') target = build.result.preview.runId;
        }
        if (target) {
          api.stop({runId: target});
          const exited = await api.wait_for_event({runId: target, until: 'exited', timeoutMs: 10000}, controller.signal);
          const exit = exited.ok ? exited.result.run?.exit : undefined;
          if (exit?.evidence === 'host-report') {
            exitStatus = exit.report.reason === 'clean-exit' ? '已验证画面变化并取得退出回执' : '已验证画面变化，退出回执显示异常结束';
          } else if (exit) exitStatus = '已验证画面变化，编辑器已关闭预览，未收到退出回执';
        }
        if (!controller.signal.aborted) status.textContent = failure ?? exitStatus;
        playtest = undefined;
        testPlay.disabled = run.disabled = false;
      }
    };
  }
}

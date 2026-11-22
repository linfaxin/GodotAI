import type {GameScreenshot} from '@godot-js/engine/browser/dedicated/worker-runner';
import type {DebugExit} from '../debug-api';
import type {PlaygroundApi, PlaygroundApiCall, createPlaygroundApi} from '../playground-api';
import {INTERACTION_DEMO_PLAYER, RUNTIME_WRITE_DEMO_X} from '../interaction-demo';
import {hasCleanRuntimeExit,runRuntimePropertiesReplay} from './runtime-properties-replay';

interface PlaytestActions {
  unavailable(): string | undefined;
  supportsRuntimeObservation(): boolean;
  supportsRuntimeWrite(): boolean;
  supportsRuntimeProperties?(): boolean;
  open(): Promise<string>;
  openProperties?(): Promise<string>;
  cancelLaunch(attemptId: string): void;
}

type CapturedPng = {png: Blob; frame: GameScreenshot};
type PlaytestMode = 'legacy' | 'input' | 'write';

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

async function findPlayer(api: PlaygroundApi, runId: string, signal: AbortSignal) {
  const tree = await api.get_runtime_tree({runId, depth: 3}, signal);
  if (!tree.ok) throw Error(tree.error.message);
  const players = tree.result.nodes.filter(node => node.name === INTERACTION_DEMO_PLAYER.name && node.type === 'Node2D');
  const player = players[0];
  if (players.length !== 1 || tree.result.run.runId !== runId) throw Error('运行时节点树中没有本次运行唯一的 Player');
  return player;
}

async function readPlayer(api: PlaygroundApi, runId: string, player: {path: string; instanceId: string}, signal: AbortSignal, timeoutMs = 5000) {
  const snapshot = await api.inspect_runtime_node({runId, path: player.path, properties: ['position'], timeoutMs}, signal);
  if (!snapshot.ok) throw Error(snapshot.error.message);
  const position = snapshot.result.properties.find(property => property.name === 'position');
  if (!position || !('value' in position) || typeof position.value !== 'object') throw Error('无法读取 Player 的 position');
  if (snapshot.result.run.runId !== runId || snapshot.result.node.instanceId !== player.instanceId ||
      snapshot.result.node.path !== player.path) throw Error('Player 实例已经更换');
  return {sampleSeq: snapshot.result.sampleSeq, position: position.value};
}

async function collectPlaytest(api: PlaygroundApi, runId: string, signal: AbortSignal, status: HTMLElement,
  mode: PlaytestMode, reportWrite: (message: string) => void) {
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

  if (mode === 'legacy') {
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

  const {startX, endX, y, viewportWidth, viewportHeight} = INTERACTION_DEMO_PLAYER;
  const destination = mode === 'write' ? RUNTIME_WRITE_DEMO_X : endX;
  const labels = mode === 'write' ? ['写入前', '写入后'] : ['输入前', '输入后'];
  let writeReleaseId: string | undefined;
  if (mode === 'write') {
    const run = api.get_run({runId});
    if (!run.ok || !run.result.runtimeWrite.ready) throw Error('本次运行尚不能写入状态');
    writeReleaseId = run.result.release.releaseId;
  }
  status.textContent = '正在读取运行时节点';
  const player = await findPlayer(api, runId, signal);
  const inspect = (timeoutMs?: number) => readPlayer(api, runId, player, signal, timeoutMs);
  const readMarker = ({png, frame}: CapturedPng) => {
    const pngCoordinate = (coordinate: number, viewport: number, source: number, output: number) => {
      const sourceCoordinate = coordinate * source / viewport;
      return Math.floor(sourceCoordinate * (output / source));
    };
    const py = pngCoordinate(y, viewportHeight, frame.sourceHeight, frame.height);
    return readPixels(png, [startX, destination].map(x => [pngCoordinate(x, viewportWidth, frame.sourceWidth, frame.width), py]));
  };
  const red = (color: Uint8ClampedArray) => matchesColor(color, 255, 0, 0);
  const white = (color: Uint8ClampedArray) => matchesColor(color, 255, 255, 255);

  const initial = await inspect();
  if (initial.position.x !== startX || initial.position.y !== y) throw Error('Player 初始位置与示例不符');
  status.textContent = '正在采集' + labels[0] + '画面';
  const before = await capture();
  const [oldPixel, newPixel] = await readMarker(before);
  if (!white(oldPixel) || !red(newPixel)) throw Error('起始画面未显示白色色块位于 Player 初始位置');

  if (mode === 'write') {
    const written = await api.runtime_set({runId, path: player.path, expectedInstanceId: player.instanceId,
      property: 'position', value: {x: destination, y}}, signal);
    if (!written.ok) {
      if (written.requestId) reportWrite('写入请求 ' + written.requestId + ' · ' + written.error.code);
      throw Error(written.error.message);
    }
    const receipt = written.result;
    const detail = receipt.outcome === 'unconfirmed' ? receipt.reason : 'x=' + receipt.observedValue.x;
    reportWrite('写入请求 ' + receipt.requestId + ' · ' + receipt.outcome + ' · ' + detail);
    if (receipt.outcome !== 'applied' || receipt.run.runId !== runId || receipt.expectedInstanceId !== player.instanceId ||
        receipt.releaseId !== writeReleaseId || receipt.observedValue.x !== destination || receipt.observedValue.y !== y)
      throw Error('未确认 Player 写入目标位置');
  } else await tap('ArrowRight');
  status.textContent = '正在验证 Player 的位置和画面';
  const remaining = untilDeadline('未观察到 Player 完成移动');
  let moved = await inspect(remaining());
  while (moved.position.x !== destination || moved.position.y !== y) moved = await inspect(remaining());
  if (moved.sampleSeq <= initial.sampleSeq) throw Error('Player 位置采样没有更新');
  let after: CapturedPng;
  for (;;) {
    after = await capture(remaining());
    const [oldPixel, newPixel] = await readMarker(after);
    if (red(oldPixel) && white(newPixel) && after.frame.renderSerial > before.frame.renderSerial) break;
  }
  const frames = [[labels[0], before, initial], [labels[1], after, moved]] as const;
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
  const testWrite = document.getElementById('agent-runtime-write') as HTMLButtonElement | null;
  const testProperties = document.getElementById('agent-runtime-properties') as HTMLButtonElement | null;
  const propertiesEvidence = document.getElementById('agent-properties-evidence');
  const propertiesDetails = document.getElementById('agent-properties-details');
  const images = document.getElementById('agent-observations');
  const writeResults = document.getElementById('agent-write-results');
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
    writeResults?.replaceChildren();
    if (writeResults) writeResults.hidden = true;
    if (propertiesEvidence) propertiesEvidence.textContent = '';
    if (propertiesDetails) propertiesDetails.hidden = true;
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
    if (playtest) { playtest.abort(); status.textContent = '正在取消验证并收尾'; return; }
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
    const sample = demo;
    testPlay.hidden = false;
    if (testWrite) testWrite.hidden = false;
    const report = (message: string) => {
      if (!writeResults) return;
      const row = document.createElement('li');
      row.textContent = message;
      writeResults.append(row);
      writeResults.hidden = false;
    };
    const recordExit = (runId: string, exit: DebugExit | undefined) =>
      report('运行 ' + runId + ' · ' + (exit ? exit.evidence + ' · ' + exit.report.reason : '退出未确认'));
    const cleanExit = hasCleanRuntimeExit;
    async function withSampleRun(input: Parameters<PlaygroundApi['play']>[0], signal: AbortSignal,
      visit: (runId: string, attemptId: string) => Promise<void>, write: boolean) {
      let attemptId: string | undefined;
      let target: string | undefined;
      let exit: DebugExit | undefined;
      try {
        signal.throwIfAborted();
        const played = api.play(input);
        if (!played.ok) throw Error(played.error.message);
        attemptId = played.result.attemptId;
        status.textContent = '正在启动试玩示例';
        const ready = await api.wait_for_event({attemptId, until: 'running'}, signal);
        target = ready.ok ? ready.result.run?.runId : undefined;
        if (!ready.ok || ready.result.outcome !== 'reached' || !target) throw Error('试玩示例未进入运行状态');
        await visit(target, attemptId);
      } finally {
        if (!target && attemptId) {
          sample.cancelLaunch(attemptId);
          const build = api.get_build({attemptId});
          if (build.ok && build.result.preview?.status === 'session-created') target = build.result.preview.runId;
        }
        if (target) {
          api.stop({runId: target});
          const exited = await api.wait_for_event({runId: target, until: 'exited', timeoutMs: 10000});
          exit = exited.ok ? exited.result.run?.exit : undefined;
          if (write) recordExit(target, exit);
        }
      }
      return {runId: target, exit};
    }
    const startPlaytest = async (write: boolean) => {
      if (playtest) return;
      const unavailable = demo.unavailable();
      if (unavailable) { status.textContent = unavailable; return; }
      if (write && !demo.supportsRuntimeWrite()) {
        status.textContent = '当前预览不支持运行时属性写入';
        return;
      }
      const controller = new AbortController();
      playtest = controller;
      const previousWait = replayWait;
      replayWait = undefined;
      previousWait?.abort();
      testPlay.disabled = run.disabled = stop.disabled = true;
      if (testWrite) testWrite.disabled = true;
      if (testProperties) testProperties.disabled = true;
      calls.length = 0;
      trace.replaceChildren();
      trace.hidden = true;
      clearImages();
      let failure: string | undefined;
      let exitStatus = '已验证画面变化，退出尚未确认';
      try {
        status.textContent = '正在打开试玩示例';
        const demoId = await demo.open();
        if (controller.signal.aborted) return;
        const context = api.get_project_context().result;
        if (context.projectId !== demoId || context.editorRevision === null) throw Error('试玩项目已切换');
        const input = {projectId: demoId, expectedEditorRevision: context.editorRevision};
        const mode = write ? 'write' : demo.supportsRuntimeObservation() ? 'input' : 'legacy';
        let sourceHash: string | undefined;
        let originalPlayer: {path:string;instanceId:string} | undefined;
        const first = await withSampleRun(input, controller.signal, async (target, attemptId) => {
          if (write) {
            const build = api.get_build({attemptId});
            sourceHash = build.ok ? build.result.sourceHash : undefined;
            if (!sourceHash) throw Error('缺少试玩示例的源码快照');
            originalPlayer = await findPlayer(api,target,controller.signal);
          }
          const samples = await collectPlaytest(api, target, controller.signal, status, mode, report);
          for (const sample of samples) {
            const figure = document.createElement('figure'), caption = document.createElement('figcaption');
            const image = document.createElement('img'), url = URL.createObjectURL(sample.png);
            imageUrls.push(url);
            caption.textContent = sample.caption;
            image.alt = sample.caption + '的游戏画面'; image.src = url;
            figure.append(caption, image); images.append(figure);
          }
          images.hidden = false;
        }, write);
        if (write) {
          const previousRunId = first.runId;
          if (!previousRunId || !cleanExit(first.exit)) throw Error('首次运行的正常退出未确认');
          const second = await withSampleRun(input, controller.signal, async (target, attemptId) => {
            const build = api.get_build({attemptId});
            if (target === previousRunId || !build.ok || build.result.sourceHash !== sourceHash)
              throw Error('重启的运行身份或源码快照不匹配');
            const player = await findPlayer(api, target, controller.signal);
            if (!originalPlayer) throw Error('首次运行的节点身份未保存');
            const stale = await api.runtime_set({runId: previousRunId, path: originalPlayer.path, expectedInstanceId: originalPlayer.instanceId,
              property: 'position', value: {x: RUNTIME_WRITE_DEMO_X, y: INTERACTION_DEMO_PLAYER.y}}, controller.signal);
            if (stale.ok || stale.error.code !== 'run_ended') throw Error('旧运行写入未被拒绝');
            const {position} = await readPlayer(api, target, player, controller.signal);
            if (position.x !== INTERACTION_DEMO_PLAYER.startX || position.y !== INTERACTION_DEMO_PLAYER.y)
              throw Error('重启后 Player 未恢复初始位置');
            report('重启运行 ' + target + ' · Player x=' + position.x);
          }, true);
          if (!cleanExit(second.exit)) throw Error('重启运行的正常退出未确认');
          exitStatus = '已验证写入、画面变化和重启恢复，并取得两次退出回执';
        } else if (first.exit?.evidence === 'host-report') {
          exitStatus = cleanExit(first.exit) ? '已验证画面变化并取得退出回执' : '已验证画面变化，退出回执显示异常结束';
        } else if (first.exit) exitStatus = '已验证画面变化，编辑器已关闭预览，未收到退出回执';
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        if (!controller.signal.aborted) status.textContent = failure ?? exitStatus;
        playtest = undefined;
        testPlay.disabled = run.disabled = false;
        if (testWrite) testWrite.disabled = false;
        if (testProperties) testProperties.disabled = false;
      }
    };
    testPlay.onclick = () => startPlaytest(false);
    if (testWrite) testWrite.onclick = () => startPlaytest(true);
  }

  if(testProperties&&demo?.openProperties&&images){
    testProperties.hidden=false;
    testProperties.onclick=async()=>{
      if(playtest)return;
      const unavailable=demo.unavailable();
      if(unavailable){status.textContent=unavailable;return;}
      if(!demo.supportsRuntimeProperties?.()){status.textContent='当前引擎不支持公开脚本属性访问';return;}
      const controller=new AbortController();playtest=controller;
      replayWait?.abort();replayWait=undefined;
      run.disabled=true;stop.disabled=false;testProperties.disabled=true;
      if(testPlay)testPlay.disabled=true;if(testWrite)testWrite.disabled=true;
      calls.length=0;trace.textContent='';trace.hidden=true;clearImages();
      const report=(message:string)=>{
        if(!writeResults)return;const row=document.createElement('li');row.textContent=message;
        writeResults.append(row);writeResults.hidden=false;
      };
      try{
        const result=await runRuntimePropertiesReplay(api,{
          open:()=>demo.openProperties!(),cancelLaunch:demo.cancelLaunch,
          status:message=>{status.textContent=message;},report,
          frame:sample=>{
            const figure=document.createElement('figure'),caption=document.createElement('figcaption'),image=document.createElement('img');
            const url=URL.createObjectURL(sample.png);imageUrls.push(url);
            caption.textContent=sample.caption;image.alt=sample.caption;image.src=url;figure.append(caption,image);images.append(figure);images.hidden=false;
          },
        },controller.signal);
        if(propertiesEvidence)propertiesEvidence.textContent=JSON.stringify(result,null,2);
        if(propertiesDetails)propertiesDetails.hidden=false;
        status.textContent='已验证公开属性、玩法变化、重启恢复和两次完整退出';
      }catch(error){
        status.textContent=controller.signal.aborted?'已取消属性验证；退出状态见运行记录':error instanceof Error?error.message:String(error);
      }finally{
        playtest=undefined;run.disabled=false;stop.disabled=true;testProperties.disabled=false;
        if(testPlay)testPlay.disabled=false;if(testWrite)testWrite.disabled=false;
      }
    };
  }
}

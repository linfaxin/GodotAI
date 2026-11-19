import type {PlaygroundApiCall, createPlaygroundApi} from '../playground-api';

interface PlaytestActions {
  unavailable(): string | undefined;
  open(): Promise<string>;
  cancelLaunch(attemptId: string): void;
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
        const capture = async (timeoutMs = 5000) => {
          const frame = await api.screenshot({runId: target!, timeoutMs}, controller.signal);
          if (!frame.ok) throw Error(frame.error.message);
          return new Blob([frame.result.bytes], {type: frame.result.mimeType});
        };
        status.textContent = '正在采集输入前画面';
        const before = await capture();
        const input = api.game_input({runId: target, gesture: {kind: 'key_tap', code: 'Space'}});
        if (!input.ok) throw Error(input.error.message);
        const receipt = await api.wait_for_input({runId: target, operationId: input.result.operationId}, controller.signal);
        if (!receipt.ok || receipt.result.operation.status !== 'dispatched') throw Error('Space 的按下和释放未全部确认分发');
        status.textContent = '正在观察输入后画面';
        const sample = async (frame: Blob) => {
          const image = await createImageBitmap(frame);
          try {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const pixel = canvas.getContext('2d')!;
            pixel.drawImage(image, image.width >> 1, image.height >> 1, 1, 1, 0, 0, 1, 1);
            const [r, g] = pixel.getImageData(0, 0, 1, 1).data;
            return {r, g};
          } finally { image.close(); }
        };
        const initial = await sample(before);
        if (initial.r < 200 || initial.g > 40) throw Error('输入前画面未显示示例的红色背景');
        const deadline = performance.now() + 5000;
        let after: Blob;
        for (;;) {
          const remaining = Math.ceil(deadline - performance.now());
          if (remaining < 1) throw Error('未观察到示例的绿色背景');
          after = await capture(remaining);
          const color = await sample(after);
          if (color.g > 200 && color.r < 40) break;
        }
        for (const [label, frame] of [['输入前', before], ['输入后', after]] as const) {
          const figure = document.createElement('figure'), caption = document.createElement('figcaption');
          const image = document.createElement('img'), url = URL.createObjectURL(frame);
          imageUrls.push(url);
          caption.textContent = label;
          image.alt = label + '的游戏画面'; image.src = url;
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

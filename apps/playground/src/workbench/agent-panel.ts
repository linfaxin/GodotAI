import type {PlaygroundApiCall, createPlaygroundApi} from '../playground-api';

export function createAgentPanel(playground: ReturnType<typeof createPlaygroundApi>) {
  const run = document.getElementById('agent-replay') as HTMLButtonElement;
  const stop = document.getElementById('agent-stop') as HTMLButtonElement;
  const status = document.getElementById('agent-status')!;
  const trace = document.getElementById('agent-trace')!;
  const {api} = playground;
  let runId: string | undefined;
  let replayWait: AbortController | undefined;
  const calls: string[] = [];

  function show(call: PlaygroundApiCall) {
    const body = JSON.stringify(call, null, 2);
    calls.push(body.length > 16_384 ? body.slice(0, 16_384) + '\n…显示已截断' : body);
    if (calls.length > 12) calls.shift();
    trace.textContent = calls.join('\n\n');
    trace.hidden = false;
  }
  playground.subscribe(show);

  run.onclick = async () => {
    replayWait?.abort();
    const controller = new AbortController();
    replayWait = controller;
    run.disabled = stop.disabled = true;
    runId = undefined;
    calls.length = 0;
    trace.textContent = '';
    trace.hidden = true;
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
        result.result.outcome === 'reached' ? '已取得退出回执' : '等待退出超时，可继续查看运行记录';
      if (result.ok && result.result.outcome === 'timeout') stop.disabled = false;
    } finally {
      run.disabled = false;
    }
  };
}

import type { DebugApi } from '../debug-api';

type Context = ReturnType<DebugApi['getContext']>['result'];
type Build = Extract<ReturnType<DebugApi['getBuild']>, { ok: true }>['result'];
type Run = Extract<ReturnType<DebugApi['getRun']>, { ok: true }>['result'];
type EventPage = Extract<ReturnType<DebugApi['readRunEvents']>, { ok: true }>['result'];
type BuildCard = 'build' | 'linked-build';
type Field = [label: string, value: string | number | null | undefined];
type Note = [text: string, tone?: 'error' | 'notice'];

const exampleOptions: NonNullable<Parameters<DebugApi['readRunEvents']>[1]> = { kinds: ['log'], limit: 30 };
const example = {
  source: `(() => {
  const debug = window.godotPlaygroundDebug;
  const { result: context } = debug.getContext();
  const runId = context.activeRunId ?? context.lastExitedRunId;
  const attemptId = context.latestBuildAttemptId;
  return {
    context,
    build: attemptId ? debug.getBuild(attemptId) : null,
    run: runId ? debug.getRun(runId) : null,
    events: runId ? debug.readRunEvents(runId, ${JSON.stringify(exampleOptions)}) : null,
  };
})()`,
  run(debug: DebugApi) {
    const { result: context } = debug.getContext();
    const runId = context.activeRunId ?? context.lastExitedRunId;
    const attemptId = context.latestBuildAttemptId;
    return {
      context,
      build: attemptId ? debug.getBuild(attemptId) : null,
      run: runId ? debug.getRun(runId) : null,
      events: runId ? debug.readRunEvents(runId, exampleOptions) : null,
    };
  },
};

const buildLabels = { pending: '构建中', succeeded: '构建成功', failed: '构建失败', cancelled: '构建已取消' };
const previewLabels = { 'not-requested': '尚未请求', preparing: '准备中', skipped: '已跳过', rejected: '准备失败', 'session-created': '已创建会话' };
const runLabels: Record<string, string> = {
  idle: '等待运行', 'loading-frame': '正在加载预览', handshaking: '正在连接预览', downloading: '正在下载引擎',
  preloading: '正在装载项目', initializing: '正在初始化引擎', starting: '正在启动场景', 'waiting-ready': '正在等待启动',
  running: '运行中', stopping: '正在停止', exited: '运行结束',
};

function setText(node: HTMLElement, value: string) {
  if (node.textContent !== value) node.textContent = value;
}

function diagnosticText(diagnostic: Build['diagnostics']['items'][number]) {
  const { location, code, message, omitted } = diagnostic;
  const position = location && [location.file, location.line, location.column].filter(value => value !== undefined).join(':');
  const codeLabel = typeof code === 'string' && (message === code || message?.includes(`${code}:`)) ? undefined : code;
  return [position, codeLabel, message, omitted ? '正文已省略' : undefined].filter(value => value !== undefined && value !== '').join(' · ');
}

export function createDebugPanel(api: DebugApi) {
  const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = element('debug-panel');
  const runEvents = element<HTMLOListElement>('debug-events');
  const filter = element<HTMLSelectElement>('debug-log-filter');
  const docs = element('debug-docs');
  const exampleResult = element('debug-example-result');
  const previous = element<HTMLButtonElement>('debug-show-previous');
  const follow = element<HTMLButtonElement>('debug-show-current');
  const renderedLists = new WeakMap<HTMLElement, string>();
  let pinnedRunId: string | null = null;
  let lastExitedRunId: string | null = null;
  let animation: number | undefined;
  let logRunId: string | null = null;
  let logLevel = '';
  let cursor: string | undefined;

  function updateList(id: string, fields: Field[] | Note[], render: () => Node[]) {
    const target = element(id);
    const key = JSON.stringify(fields);
    if (renderedLists.get(target) === key) return;
    renderedLists.set(target, key);
    target.replaceChildren(...render());
  }

  function renderFields(id: string, fields: Field[]) {
    updateList(id, fields, () => fields.flatMap(([label, value]) => {
      if (value === null || value === undefined) return [];
      const term = document.createElement('dt'), definition = document.createElement('dd');
      term.textContent = label;
      definition.textContent = String(value);
      return [term, definition];
    }));
  }

  function renderNotes(id: string, notes: Note[]) {
    updateList(id, notes, () => notes.map(([text, tone]) => {
      const line = document.createElement('p');
      line.className = 'debug-note';
      line.textContent = text;
      if (tone) line.dataset.tone = tone;
      return line;
    }));
  }

  function renderStatus(id: string, text: string, tone = '') {
    const status = element(id);
    setText(status, text);
    status.dataset.tone = tone;
  }

  function renderJson(kind: BuildCard | 'run', record: Build | Run | undefined) {
    const details = element<HTMLDetailsElement>('debug-' + kind + '-details');
    details.hidden = !record;
    if (!record || details.open) setText(element('debug-' + kind + '-json'), record ? JSON.stringify(record, null, 2) : '');
  }

  function renderContext(context: Context) {
    const { release, preview } = context;
    const notes: Note[] = [];
    if (release.status === 'available') {
      const { engineProfile, releaseId } = release.value;
      const configuration = preview.status === 'available' ? ` · Dedicated Worker / ${preview.value.presentationBackend}` : '';
      notes.push([`${engineProfile}${configuration} · ${releaseId}`]);
    }
    if (release.status === 'loading') notes.push(['正在验证引擎发布']);
    if (release.status === 'unsupported') notes.push([release.reason ?? '当前页面仅提供编辑器']);
    if (release.status === 'failed') notes.push([`发布加载失败 · ${diagnosticText(release.error.diagnostic)}`, 'error']);
    if (preview.status === 'failed') notes.push([`预览环境准备失败 · ${diagnosticText(preview.error.diagnostic)}`, 'error']);
    if (release.status === 'available' && preview.status === 'loading') notes.push(['正在准备预览环境']);
    if (release.status === 'available' && preview.status === 'unsupported') notes.push([preview.reason ?? '当前预览环境不提供运行调试']);
    renderNotes('debug-context', notes);
  }

  function renderBuild(kind: BuildCard, build: Build | undefined, expired: boolean) {
    const prefix = 'debug-' + kind;
    const card = element(prefix);
    card.dataset.status = build?.status ?? (expired ? 'not-found' : 'empty');
    card.dataset.attemptId = build?.attemptId ?? '';
    card.dataset.previewStatus = build?.preview?.status ?? '';
    const tone = build?.status === 'failed' ? 'error' : build?.status === 'succeeded' ? 'good' : '';
    renderStatus(prefix + '-status', build ? buildLabels[build.status] : expired ? '构建记录已过期' : '尚无构建', tone);
    renderFields(prefix + '-fields', build ? [
      ['尝试', build.attemptId], ['编辑版本', build.editorRevision], ['产物', build.artifact?.variant],
      ['预览', build.preview ? previewLabels[build.preview.status] : undefined],
    ] : []);
    const notes: Note[] = [];
    if (build) {
      if (build.error) notes.push([`${build.error.stage} · ${diagnosticText(build.error.diagnostic)}`, 'error']);
      if (build.preview?.status === 'rejected') {
        notes.push([`${build.preview.error.stage} · ${diagnosticText(build.preview.error.diagnostic)}`, 'error']);
      }
      const { diagnostics } = build;
      if (diagnostics.counts) {
        const { error, warning, info } = diagnostics.counts;
        notes.push([`${error} 个错误 · ${warning} 个警告 · ${info} 条信息`]);
      } else if (build.status !== 'pending' && !diagnostics.observed) {
        notes.push(['未观测到构建诊断']);
      }
      for (const item of diagnostics.items) {
        const tone = item.severity === 'error' ? 'error' : item.severity === 'warning' ? 'notice' : undefined;
        notes.push([diagnosticText(item), tone]);
      }
      if (diagnostics.omittedCount) notes.push([`${diagnostics.omittedCount} 条诊断未保留`, 'notice']);
    }
    renderNotes(prefix + '-notes', notes);
    renderJson(kind, build);
  }

  function renderRun(run: Run | undefined, runId: string | null, activeRunId: string | null) {
    const card = element('debug-run');
    card.dataset.runId = run?.runId ?? '';
    card.dataset.state = run?.state ?? (runId ? 'not-found' : 'empty');
    const exit = run?.exit;
    card.dataset.exitEvidence = exit?.evidence ?? '';
    setText(element('debug-run-heading'), pinnedRunId ? '选定运行' : activeRunId ? '当前运行' : '最近运行');
    const reason = exit?.report.reason;
    const tone = reason ? reason === 'clean-exit' ? 'good' : 'error' : run?.state === 'running' ? 'good' : '';
    const status = run ? runLabels[run.state] ?? run.state : runId ? '运行记录已过期' : '尚无运行';
    renderStatus('debug-run-status', reason ? `${status} · ${reason}` : status, tone);
    renderFields('debug-run-fields', run ? [
      ['运行', run.runId], ['项目', run.projectId], ['构建尝试', run.attemptId],
      ['回执来源', exit && (exit.evidence === 'host-report' ? '宿主回执' : '页面兜底')],
      ['原生退出码', exit?.report.sessionFacts?.nativeExit?.code],
      ['入口清理', exit?.report.sessionFacts?.entryCleanup],
      ['宿主清理', exit?.report.sessionFacts?.hostCleanup],
    ] : []);
    const diagnostic = exit?.report.diagnostic?.message ?? exit?.report.detail;
    renderNotes('debug-run-notes', diagnostic ? [[diagnostic, 'error']] : []);
    renderJson('run', run);
  }

  function makeLogRow({ seq, event }: EventPage['items'][number]) {
    const row = document.createElement('li');
    row.dataset.seq = String(seq);
    const index = document.createElement('span'), level = document.createElement('span'), message = document.createElement('span');
    index.className = 'debug-event-index';
    index.textContent = String(seq);
    level.className = 'debug-event-level';
    if (event.type === 'log') {
      row.dataset.level = event.level ?? '';
      level.textContent = event.level ?? 'log';
      message.textContent = 'omitted' in event ? '此条日志正文未保留' : event.text;
    }
    row.append(index, level, message);
    return row;
  }

  function renderLogs(runId: string | null) {
    const gap = element('debug-events-gap');
    const empty = element('debug-events-empty');
    const level = filter.value;
    if (runId !== logRunId || level !== logLevel) {
      logRunId = runId;
      logLevel = level;
      cursor = undefined;
      gap.hidden = true;
      runEvents.replaceChildren();
    }
    let message = runId ? '没有匹配的运行日志' : '尚无运行日志';
    if (runId) {
      const levels = level === 'error' ? ['error'] as const : level === 'warn' ? ['warn', 'error'] as const : undefined;
      let hasMore = true;
      while (hasMore) {
        const response = api.readRunEvents(runId, { after: cursor, limit: 100, kinds: ['log'], levels });
        if (!response.ok) {
          message = response.error.code === 'not_found' ? '运行日志已超出保留范围' : response.error.message;
          runEvents.replaceChildren();
          gap.hidden = true;
          cursor = undefined;
          break;
        }
        const { items, nextCursor, oldestAvailableSeq } = response.result;
        while (runEvents.firstElementChild && (oldestAvailableSeq === null || Number((runEvents.firstElementChild as HTMLElement).dataset.seq) < oldestAvailableSeq)) {
          runEvents.firstElementChild.remove();
        }
        const trimmedThrough = oldestAvailableSeq === null ? response.result.gap?.toSeq : oldestAvailableSeq - 1;
        if (trimmedThrough) {
          setText(gap, `较早的事件 1–${trimmedThrough} 已移出记录`);
          gap.hidden = false;
        }
        runEvents.append(...items.filter(item => item.event.type === 'log').map(makeLogRow));
        hasMore = response.result.hasMore && nextCursor !== cursor;
        cursor = nextCursor;
      }
    }
    setText(empty, message);
    empty.hidden = !!runEvents.childElementCount;
  }

  function selectedRunId(context: Context) {
    return pinnedRunId ?? context.activeRunId ?? context.lastExitedRunId;
  }

  function render() {
    const { result: context } = api.getContext();
    const attempt = context.latestBuildAttemptId && api.getBuild(context.latestBuildAttemptId);
    const runId = selectedRunId(context);
    const run = runId ? api.getRun(runId) : undefined;
    const runRecord = run?.ok ? run.result : undefined;
    const linkedBuild = runRecord && runRecord.attemptId !== context.latestBuildAttemptId ? api.getBuild(runRecord.attemptId) : undefined;
    lastExitedRunId = context.lastExitedRunId;
    follow.hidden = !pinnedRunId;
    previous.hidden = !lastExitedRunId || lastExitedRunId === runId;
    renderContext(context);
    renderBuild('build', attempt && attempt.ok ? attempt.result : undefined, Boolean(attempt && !attempt.ok));
    renderRun(runRecord, runId, context.activeRunId);
    element('debug-linked-build').hidden = !linkedBuild;
    renderBuild('linked-build', linkedBuild?.ok ? linkedBuild.result : undefined, linkedBuild?.ok === false);
    renderLogs(runId);
  }

  function refresh() {
    if (animation !== undefined || panel.hidden || document.body.classList.contains('dock-collapsed')) return;
    animation = requestAnimationFrame(() => {
      animation = undefined;
      if (!panel.hidden && !document.body.classList.contains('dock-collapsed')) render();
    });
  }

  setText(element('debug-api-example'), example.source);
  element('debug-open-docs').onclick = event => {
    docs.hidden = !docs.hidden;
    (event.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!docs.hidden));
  };
  element('debug-copy-example').onclick = async () => {
    const status = element('debug-example-status');
    try {
      await navigator.clipboard.writeText(example.source);
      setText(status, '已复制');
    } catch {
      setText(status, '无法访问剪贴板，可选择代码复制');
    }
  };
  element('debug-run-example').onclick = () => {
    setText(exampleResult, JSON.stringify(example.run(api), null, 2));
    exampleResult.hidden = false;
  };
  previous.onclick = () => {
    pinnedRunId = lastExitedRunId;
    element('debug-events-heading').focus({ preventScroll: true });
    refresh();
  };
  follow.onclick = () => {
    pinnedRunId = null;
    element('debug-events-heading').focus({ preventScroll: true });
    refresh();
  };
  filter.onchange = refresh;
  element('debug-build-details').addEventListener('toggle', refresh);
  element('debug-linked-build-details').addEventListener('toggle', refresh);
  element('debug-run-details').addEventListener('toggle', refresh);
  panel.addEventListener('dock-open', refresh);
  refresh();
  return { refresh, showsRun: (runId: string) => selectedRunId(api.getContext().result) === runId };
}

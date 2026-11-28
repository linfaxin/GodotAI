import {CONSOLE_OPERATIONS, getConsoleOperation, MAX_CONSOLE_READ_PROPERTIES, type ConsoleOperation, type ConsoleOperationId} from './api-console-catalog';
import {CONSOLE_LESSONS, type ConsoleLessonStep} from './api-console-presets';
import {consoleResultSource, stringifyConsoleJson} from './api-console-session';
import type {ConsoleCall, ConsoleCapability, ConsoleFillSelection, ConsoleSession, ConsoleSnapshot} from './api-console-types';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Each API card keeps its own view state. Calls, drafts and attachments belong to the shared session. */
export function createApiConsole(container: HTMLElement, navigation: HTMLElement, session: ConsoleSession,
  openOperation: (id: ConsoleOperationId, focus?: boolean) => void) {
  const entries = new Map<ConsoleOperationId, HTMLButtonElement>();
  const cards = new Map<ConsoleOperationId, ReturnType<typeof createApiConsoleCard>>();
  const urls = new Map<string, string>();
  let active: ConsoleOperationId | null = null;

  for (const [family, label] of [['summer', 'Summer 风格'], ['local', 'GodotAI 本地辅助']] as const) {
    const group = element('section');
    group.append(element('h3', 'api-list-group', label));
    for (const operation of CONSOLE_OPERATIONS.filter(item => item.family === family)) {
      const entry = element('button', 'api-list-entry'); entry.type = 'button';
      entry.dataset.apiOperation = operation.id;
      entry.title = `${operation.name}\n${operation.description}`;
      entry.append(element('span', 'api-list-name', operation.name), element('span', 'api-list-summary', operation.title));
      entry.onclick = () => openOperation(operation.id);
      entries.set(operation.id, entry); group.append(entry);
    }
    navigation.append(group);
  }

  function attachmentUrl(id: string, blob: Blob) {
    let url = urls.get(id);
    if (!url) {url = URL.createObjectURL(blob); urls.set(id, url);}
    return url;
  }
  const unsubscribe = session.subscribe(() => {
    for (const [id, url] of urls) if (!session.getAttachment(id)) {URL.revokeObjectURL(url); urls.delete(id);}
    for (const card of cards.values()) card.discardExpiredSelection();
    if (active) cards.get(active)?.render();
  });

  return {
    show(id: ConsoleOperationId | null) {
      if (id === active) return;
      if (active) {cards.get(active)?.hide(); entries.get(active)?.removeAttribute('aria-current');}
      active = id;
      if (!id) return;
      let card = cards.get(id);
      if (!card) {
        card = createApiConsoleCard(container, session, getConsoleOperation(id)!, {
          attachmentUrl,
          loadRecovery: () => openOperation('engine.get_debugger_errors', false),
          loadHistory(operationId, callId) {
            const operation = getConsoleOperation(operationId);
            if (!operation) return;
            openOperation(operation.id, false);
            cards.get(operation.id)?.loadHistory(callId);
          },
          loadLesson(step) {
            const operation = getConsoleOperation(step.operationId);
            if (!operation) return;
            openOperation(operation.id, false);
            cards.get(operation.id)?.loadLesson(step);
          },
        });
        cards.set(id, card);
      }
      entries.get(id)?.setAttribute('aria-current', 'true');
      session.selectOperation(id);
      card.show();
    },
    dispose() {
      unsubscribe();
      for (const card of cards.values()) card.dispose();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      cards.clear(); urls.clear(); entries.clear(); navigation.replaceChildren();
    },
  };
}

function createApiConsoleCard(container: HTMLElement, session: ConsoleSession, operation: ConsoleOperation, hooks: {
  attachmentUrl(id: string, blob: Blob): string;
  loadRecovery(): void;
  loadHistory(operationId: string, callId: string): void;
  loadLesson(step: ConsoleLessonStep): void;
}) {
  const events = new AbortController();
  let disposed = false, composing = false, selectedCallId: string | undefined;
  let historyKey = '', sourcesKey = '', message = '', scrollTop = 0;
  let savedSourceSelection: ConsoleFillSelection | undefined;
  let readSourceSelection: (() => ConsoleFillSelection) | undefined;

  function setText(node: HTMLElement, value: string) {
    if (node.textContent !== value) node.textContent = value;
  }
  function capabilityText(capability?: ConsoleCapability) {
    if (capability?.supported == null) return '待确认';
    if (!capability.supported) return '不支持';
    return capability.ready ? '可用' : '未就绪';
  }
  function test<T extends HTMLElement>(node: T, name: string): T {
    node.dataset.testid = 'api-console-' + name;
    return node;
  }
  function button(text: string, name: string, action: () => unknown) {
    const node = test(element('button', '', text), name);
    node.type = 'button';
    node.onclick = () => {if (!disposed && !panel.hidden) act(action);};
    return node;
  }
  function act(action: () => unknown) {
    message = '';
    try {
      const result = action();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch(error => {
          if (!disposed) {message = error instanceof Error ? error.message : String(error); render();}
        });
      }
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    if (!disposed) render();
  }
  const panel = element('section', 'api-console-card');
  panel.id = `api-card-${operation.id}`;
  panel.dataset.apiCard = operation.id;
  panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `api-tab-${operation.id}`);
  panel.hidden = true;
  const root = element('div', 'api-console');
  const heading = element('div', 'api-console-heading');
  const title = element('h2', '', operation.name);
  const open = button('打开独立示例', 'open-example', () => session.openExample());
  const recover = button('一键演示故障恢复', 'run-recovery', () => {
    selectedCallId = undefined;
    return session.runRecovery(hooks.loadRecovery);
  });
  const cancelRecovery = button('取消演示', 'cancel-recovery', () => session.cancelRecovery());
  const recoveryStatus = test(element('p', 'api-console-status'), 'recovery-status');
  recoveryStatus.setAttribute('role', 'status');
  heading.append(title, open, recover, cancelRecovery);
  recover.hidden = true;
  cancelRecovery.hidden = true;
  recoveryStatus.hidden = true;
  const exampleNote = element('p', 'api-console-note', '打开示例会切换项目并结束当前预览，原项目保留；不会自动运行。');
  open.hidden = exampleNote.hidden = operation.id === 'get_run';
  const context = test(element('dl', 'api-console-context'), 'context');
  function contextRow(label: string) {
    const term = element('dt', '', label), value = element('dd'); context.append(term, value); return value;
  }
  const contextRows = ['编辑项目 / 版本', '主运行 / 源码版本', '运行归属 / 阶段', '待启动 attempt'].map(contextRow);
  const capabilityRows = ([
    ['observation', '运行时观察'], ['runtimeWrite', '原生属性写入'],
    ['runtimeProperties', '公开属性访问'], ['runtimeCall', '公开方法调用'], ['gameProbe', '游戏帧探测'],
    ['inputScript', '物理帧输入'], ['interaction', '截图与输入'],
  ] as const).map(([key, label]) => ({key, value: contextRow(label)}));
  const compatibility = element('p', 'api-console-note', operation.family === 'summer'
    ? 'Summer 风格输入子集 · 部分语义 · GodotAI typed-v1 结果' : 'GodotAI 本地辅助');
  const composer = element('section', 'api-console-composer');
  composer.setAttribute('aria-label', '构造 API 调用');
  const description = element('p', 'api-console-description', operation.description);
  const restrictions = element('details', 'api-console-limits');
  restrictions.append(element('summary', '', '支持参数与限制'));
  const parameterList = element('dl', 'api-console-parameters'), limitationList = element('ul');
  restrictions.append(parameterList, limitationList);
  for (const parameter of operation.parameters) parameterList.append(element('dt', '', parameter.name + (parameter.required ? ' *' : '')), element('dd', '', parameter.description));
  if (!operation.parameters.length) parameterList.append(element('dt', '', '无参数'), element('dd', '', 'input 使用 {}。'));
  for (const limit of operation.limitations) limitationList.append(element('li', '', limit));
  const inputLabel = element('label', 'api-console-label', 'input 参数 JSON');
  const input = test(element('textarea'), 'input');
  input.id = `${panel.id}-input`; inputLabel.htmlFor = input.id;
  input.spellcheck = false; input.wrap = 'off'; input.rows = 8;
  const hint = element('p', 'api-console-note', '只编辑 input；Ctrl/Cmd + Enter 执行。草稿仅保存在当前页面，选择预设和历史不会执行。');
  hint.id = `${panel.id}-hint`;
  input.addEventListener('input', () => {if (!panel.hidden) act(() => session.updateDraft(input.value));}, {signal: events.signal});
  input.addEventListener('compositionstart', () => {composing = true;}, {signal: events.signal});
  input.addEventListener('compositionend', () => {composing = false;}, {signal: events.signal});
  input.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      // Never let the global source-build shortcut receive an API edit gesture.
      event.stopPropagation();
      if (composing || event.isComposing) return;
      event.preventDefault();
      if (!panel.hidden && !event.repeat && !execute.disabled) act(submit);
    }
  }, {signal: events.signal});
  const actions = element('div', 'api-console-actions');
  const preset = button('填入预设', 'preset', () => {
    const value = operation.createPreset(session.snapshot().environment.anchor);
    session.loadPreset(operation.id, stringifyConsoleJson(value.input));
    if (value.missing.length) message = `还需实际结果来源：${value.missing.join('、')}`;
  });
  const update = button('更新目标 / 填入上下文', 'update-target', () => session.updateTarget());
  const format = button('格式化 JSON', 'format', () => {
    const parsed: unknown = JSON.parse(input.value);
    session.updateDraft(stringifyConsoleJson(parsed));
  });
  function submit() { selectedCallId = undefined; return session.submit(); }
  const execute = button('执行', 'execute', submit); execute.classList.add('api-console-primary');
  const cancel = button('请求取消', 'cancel', () => session.cancel());
  cancel.title = '请求取消不撤销已经执行的写入或输入；以实际回执为准。';
  actions.append(preset, update, format, execute, cancel);
  const status = test(element('p', 'api-console-status'), 'status'); status.setAttribute('role', 'status');
  const error = test(element('p', 'api-console-error'), 'client-error'); error.id = `${panel.id}-error`; error.setAttribute('role', 'alert');
  input.setAttribute('aria-describedby', `${hint.id} ${error.id}`);
  const notification = test(element('p', 'api-console-note'), 'message'); notification.setAttribute('role', 'status');
  const requestDetails = element('details', 'api-console-request');
  requestDetails.append(element('summary', '', '完整请求（只读）'));
  const request = test(element('pre'), 'request');
  const copyRequest = button('复制请求', 'copy-request', () => copy(request.textContent ?? ''));
  requestDetails.append(copyRequest, request);
  composer.append(description, restrictions, inputLabel, input, hint, actions, status, error, notification, requestDetails);

  const resultSection = element('section', 'api-console-results');
  const resultHeading = element('div', 'api-console-section-heading'); resultHeading.append(element('h3', '', '调用结果'));
  const copyResult = button('复制结果摘要', 'copy-result', () => copy(result.textContent ?? ''));
  resultHeading.append(copyResult);
  const resultStatus = test(element('p', 'api-console-result-status'), 'result-status');
  const result = test(element('pre'), 'result');
  const callDetails = element('details'); callDetails.append(element('summary', '', '本条调用的原始请求'));
  const callRequest = test(element('pre'), 'call-request'); callDetails.append(callRequest);
  const attachments = test(element('div', 'api-console-attachments'), 'attachments');
  const sources = test(element('section', 'api-console-sources'), 'sources');
  sources.hidden = true;
  resultSection.append(resultHeading, resultStatus, result, callDetails, attachments, sources);

  const historySection = element('section', 'api-console-history-section');
  const historyHeading = element('div', 'api-console-section-heading'); historyHeading.append(element('h3', '', '共享调用历史'));
  const clear = button('清空已结算记录', 'clear-history', () => session.clearSettled()); historyHeading.append(clear);
  const history = test(element('ol', 'api-console-history'), 'history');
  historySection.append(historyHeading, history);
  const lessons = test(element('details', 'api-console-lessons'), 'lessons'); lessons.append(element('summary', '', '手工教学流程'));
  for (const lesson of CONSOLE_LESSONS) {
    const section = element('section'); section.append(element('h3', '', lesson.title), element('p', 'api-console-note', lesson.description));
    const steps = element('ol');
    for (const step of lesson.steps) {
      const row = element('li');
      const load = button(step.label, 'lesson-step', () => hooks.loadLesson(step));
      load.dataset.lessonId = lesson.id; load.dataset.stepId = step.id; row.append(load);
      if (step.notes) row.append(element('p', 'api-console-note', step.notes));
      steps.append(row);
    }
    section.append(steps); lessons.append(section);
  }
  root.append(heading, exampleNote, recoveryStatus, context, compatibility, composer, resultSection, historySection, lessons);
  panel.append(root); container.append(panel);

  async function copy(text: string) {
    try {await navigator.clipboard.writeText(text); message = '已复制';}
    catch {message = '无法访问剪贴板，请选择文本手动复制。';}
    if (!disposed) render();
  }
  function requestText(draft: {operationId: string; inputText: string}) {
    try {
      const item = getConsoleOperation(draft.operationId), value: unknown = JSON.parse(draft.inputText);
      return stringifyConsoleJson(item?.family === 'summer' ? {op: item.name, input: value} : {method: item?.name ?? draft.operationId, input: value});
    } catch { return 'input JSON 尚未解析成功。'; }
  }
  function renderHistory(state: ConsoleSnapshot, selected?: ConsoleCall) {
    const key = JSON.stringify(state.history.map(call => [call.callId, call.phase, call.summary, call.settledAt]));
    if (key !== historyKey) {
      historyKey = key; history.replaceChildren();
      for (const {callId, draft: {operationId}, phase, summary} of [...state.history].reverse().sort((a, b) => b.submittedAt - a.submittedAt)) {
        const row = element('li'); row.dataset.callId = callId; row.dataset.phase = phase;
        const view = button(`${operationId} · ${summary ?? phase}`, 'history-view', () => {selectedCallId = callId;});
        view.dataset.action = 'view-history'; view.setAttribute('aria-label', `查看 ${callId} ${operationId}`);
        const load = button('载入参数', 'history-load', () => hooks.loadHistory(operationId, callId));
        load.dataset.action = 'load-history'; row.append(view, load); history.append(row);
      }
      if (!state.history.length) history.append(element('li', 'api-console-note', '尚无调用。每次执行仅记录一条历史。'));
    }
    for (const row of history.children) {
      const active = (row as HTMLElement).dataset.callId === selected?.callId;
      row.classList.toggle('selected', active);
      row.querySelector('button')?.setAttribute('aria-pressed', String(active));
    }
    clear.disabled = state.owner === 'recovery' || !state.history.some(call => call.phase !== 'pending');
  }
  function renderSources(call?: ConsoleCall) {
    const facts = call?.resultFacts;
    const kind = consoleResultSource(operation.id, facts);
    const key = kind && call ? `${call.callId}:${kind}:${operation.id}` : '';
    if (key === sourcesKey) return;
    readSourceSelection = undefined;
    sourcesKey = key; sources.replaceChildren(); sources.hidden = !kind;
    if (!call || !facts || !kind) return;
    const sourceCallId = call.callId;
    const saved = savedSourceSelection?.sourceCallId === sourceCallId ? savedSourceSelection : undefined;
    sources.append(element('h4', '', '使用此结果填参'), element('p', 'api-console-note', `来源 ${sourceCallId}；只填入当前所选操作，不会执行。`));
    let node: HTMLSelectElement | undefined, probeTarget: HTMLSelectElement | undefined, method: HTMLSelectElement | undefined, properties: HTMLSelectElement | undefined, stopped: HTMLSelectElement | undefined;
    function select(label: string, name: string) {
      const text = element('label', 'api-console-label', label), value = test(element('select'), name);
      text.append(value); sources.append(text); return value;
    }
    if (kind === 'node' && facts.nodes) {
      node = select('节点（明确选择实际路径）', 'source-node');
      const placeholder = element('option', '', '请选择节点…'); placeholder.value = ''; node.append(placeholder);
      for (const target of facts.nodes) {
        const option = element('option', '', `${target.path} · ${target.type} · #${target.instanceId}`); option.value = target.path; node.append(option);
      }
      node.value = saved?.nodePath ?? '';
      if (operation.id === 'engine.game_probe') {
        probeTarget = select('填入范围', 'probe-target');
        const properties = element('option', '', '追加 position 和 visible'); properties.value = 'properties';
        const tree = element('option', '', '树根路径'); tree.value = 'tree';
        probeTarget.append(properties, tree);
        probeTarget.value = saved?.probeTarget ?? 'properties';
      }
    }
    if (kind === 'method' && facts.methods) {
      method = select('方法（明确选择登记签名）', 'source-method');
      const placeholder = element('option', '', '请选择方法…'); placeholder.value = ''; method.append(placeholder);
      for (const entry of facts.methods) {
        const option = element('option', '', entry.signature); option.value = entry.name; method.append(option);
      }
      method.value = saved?.methodName ?? '';
    }
    if (kind === 'properties' && facts.properties) {
      properties = select(`属性（每次最多 ${MAX_CONSOLE_READ_PROPERTIES} 项）`, 'source-properties');
      properties.multiple = true; properties.size = Math.min(4, facts.properties.length);
      for (const property of facts.properties) {
        const option = element('option', '', `${property.name} · ${property.type}`); option.value = property.name;
        option.selected = saved?.propertyNames?.includes(property.name) ?? false;
        properties.append(option);
      }
    }
    if (kind === 'stopped-run' && facts.stoppedRunIds) {
      stopped = select('已捕获的停止目标', 'source-run');
      const placeholder = element('option', '', '请选择原 run…'); placeholder.value = ''; stopped.append(placeholder);
      for (const runId of facts.stoppedRunIds) {const option = element('option', '', runId); option.value = runId; stopped.append(option);}
      stopped.value = saved?.stoppedRunId ?? '';
    }
    if (kind === 'event-cursor' && facts.eventCursor)
      sources.append(element('p', 'api-console-note', `续读序号 ${facts.eventCursor.since}`));
    if (kind === 'file' && facts.file)
      sources.append(element('p', 'api-console-note', `${facts.file.path} · 编辑版本 ${facts.file.editorRevision}`));
    if (kind === 'attempt') sources.append(element('p', 'api-console-note', `attemptId: ${facts.attemptId}`));
    if (facts.run) sources.append(element('p', 'api-console-note', `runId: ${facts.run.identity.runId}`));
    if (kind === 'input' && facts.input) sources.append(element('p', 'api-console-note', `输入: ${facts.input.runId} / ${facts.input.operationId}`));
    function readSelection(): ConsoleFillSelection {
      const selection: ConsoleFillSelection = {sourceCallId};
      if (node) selection.nodePath = node.value;
      if (probeTarget) selection.probeTarget = probeTarget.value === 'tree' ? 'tree' : 'properties';
      if (method) selection.methodName = method.value;
      if (properties) selection.propertyNames = Array.from(properties.selectedOptions, option => option.value);
      if (stopped) selection.stoppedRunId = stopped.value;
      return selection;
    }
    if (node || method || properties || stopped) readSourceSelection = readSelection;
    const use = button('填入当前操作', 'use-result', () => session.updateTarget(readSelection()));
    use.dataset.sourceId = sourceCallId;
    const propertyLimit = properties ? test(element('p', 'api-console-error', `每次最多 ${MAX_CONSOLE_READ_PROPERTIES} 项属性，请减少选择。`), 'source-property-limit') : undefined;
    if (propertyLimit) {propertyLimit.setAttribute('role', 'status'); sources.append(propertyLimit);}
    const readiness = () => {
      const count = properties?.selectedOptions.length ?? 0;
      const overLimit = count > MAX_CONSOLE_READ_PROPERTIES;
      if (propertyLimit) propertyLimit.hidden = !overLimit;
      use.disabled = !!node && !node.value || !!method && !method.value || !!properties && (!count || overLimit) || !!stopped && !stopped.value;
    };
    for (const field of [node, method, properties, stopped]) if (field) field.onchange = readiness;
    readiness(); sources.append(use);
    if (facts.truncated) sources.append(element('p', 'api-console-note', '来源列表已截断；这里只能使用已保留的事实。'));
  }
  function renderAttachment(call?: ConsoleCall) {
    const id = call?.attachmentId, attachment = id ? session.getAttachment(id) : undefined;
    const key = id && attachment ? id : call?.attachmentReleased ? `${call.callId}:released` : '';
    if (attachments.dataset.attachmentKey === key) return;
    attachments.dataset.attachmentKey = key; attachments.replaceChildren(); attachments.hidden = !key;
    if (!id || !attachment) {
      if (call?.attachmentReleased) attachments.append(element('p', 'api-console-note', '附件已释放；实际截图结果与元数据保留在摘要中。'));
      return;
    }
    const figure = element('figure'), image = element('img'), caption = element('figcaption');
    image.src = hooks.attachmentUrl(id, attachment.blob); image.alt = `实际游戏截图 ${call!.callId}`;
    const metadata = attachment.metadata;
    caption.textContent = `${metadata.width} × ${metadata.height} · renderSerial ${metadata.renderSerial} · run ${metadata.run.runId} · release ${metadata.releaseId}`;
    figure.append(image, caption); attachments.append(figure);
  }
  function renderResult(call?: ConsoleCall) {
    resultStatus.textContent = call ? `${call.callId} · ${call.draft.operationId} · ${call.summary ?? call.phase}` : '执行后在此显示原 API 的结果。';
    setText(result, call?.resultProjection ?? (call?.phase === 'pending' ? '等待原 API 结算…' : '尚无结果。'));
    result.dataset.phase = call?.phase ?? 'empty';
    copyResult.disabled = !call?.resultProjection;
    callDetails.hidden = !call; setText(callRequest, call ? requestText(call.draft) : '');
    renderSources(call); renderAttachment(call);
  }
  function render() {
    if (disposed || panel.hidden) return;
    const state = session.snapshot(), anchor = state.environment.anchor;
    if (state.operationId !== operation.id) return;
    if (input.value !== state.draft.inputText) input.value = state.draft.inputText;
    contextRows[0].textContent = `${anchor.editorProjectId ?? '未选择'} / ${anchor.editorRevision ?? '—'}`;
    contextRows[1].textContent = `${anchor.activeRunId ?? '无主运行'} / ${anchor.activeRunRevision ?? '—'}`;
    contextRows[2].textContent = `${anchor.activeRunProjectId ?? '—'} / ${state.environment.activeRunState ?? '待确认'}`;
    contextRows[3].textContent = anchor.pendingAttemptId ?? '无';
    for (const {key, value} of capabilityRows) setText(value, capabilityText(state.environment.capabilities?.[key]));
    execute.disabled = state.owner !== null || !!state.pendingCallId;
    const methodExample = operation.id === 'engine.runtime_call' || operation.id === 'describe_runtime_methods';
    const inputExample = operation.id === 'engine.game_input';
    const recoveryExample = ['engine.get_debugger_errors', 'engine.read_file', 'engine.write_file'].includes(operation.id);
    open.disabled = state.owner !== null || methodExample && state.environment.methodExampleAvailable !== true ||
      (inputExample || recoveryExample) && state.environment.inputExampleAvailable !== true;
    const recoveryEntry = operation.id === 'engine.get_debugger_errors';
    recover.hidden = !recoveryEntry;
    recover.disabled = state.owner !== null || state.environment.inputExampleAvailable !== true;
    cancelRecovery.hidden = state.owner !== 'recovery';
    recoveryStatus.hidden = !state.recovery || !recoveryEntry && state.owner !== 'recovery';
    recoveryStatus.dataset.phase = state.recovery?.phase ?? '';
    setText(recoveryStatus, state.recovery?.message ?? '');
    if (methodExample) setText(exampleNote, state.environment.methodExampleAvailable === true
      ? '打开玩法方法示例。选择方法和填参后，由你执行调用。'
      : '当前引擎发布或呈现模式不支持玩法方法示例。');
    if (inputExample) setText(exampleNote, state.environment.inputExampleAvailable === true
      ? '打开物理帧输入示例，按教程从调用历史选择运行。'
      : '物理帧输入示例需要支持输入脚本和帧探测的 Chromium Direct 预览。');
    if (recoveryExample) setText(exampleNote, state.environment.inputExampleAvailable === true
      ? recoveryEntry ? '演示会切到独立示例并结束当前预览，随后自动修复、试玩和停止。'
        : '打开故障示例并结束当前预览。需手动 Play。'
      : '故障恢复示例需要支持输入脚本和帧探测的 Chromium Full/debug Direct 预览。');
    const pendingHere = state.history.some(call => call.callId === state.pendingCallId && call.draft.operationId === operation.id);
    cancel.hidden = !pendingHere || !state.cancellable;
    status.textContent = state.owner === 'recovery' ? '故障恢复演示正在运行；结束后可手工调用。'
      : state.owner === 'replay' ? '自动验证正在运行；结束后可手工调用。'
      : state.owner === 'open-example' ? '正在准备独立示例…'
      : pendingHere ? '请求处理中；可继续编辑下一份草稿。'
      : state.pendingCallId ? '另一个 API 的请求正在处理。' : '手工执行；载入参数或使用结果均不会自动调用。';
    status.dataset.phase = pendingHere ? 'pending' : 'idle';
    error.textContent = state.clientError?.message ?? ''; error.hidden = !state.clientError;
    input.setAttribute('aria-invalid', String(state.clientError?.kind === 'json'));
    notification.textContent = message; notification.hidden = !message;
    setText(request, requestText(state.draft));
    const call = state.history.find(entry => entry.callId === selectedCallId)
      ?? [...state.history].reverse().find(entry => entry.draft.operationId === operation.id);
    renderHistory(state, call); renderResult(call);
  }
  return {
    render,
    show() {
      panel.hidden = false; render(); panel.scrollTop = scrollTop;
      savedSourceSelection = undefined;
    },
    hide() {
      savedSourceSelection = readSourceSelection?.();
      scrollTop = panel.scrollTop; panel.hidden = true;
      // Rebuild shared call data from the session the next time the card is shown.
      history.replaceChildren(); historyKey = '';
      renderResult();
    },
    discardExpiredSelection() {
      if (savedSourceSelection && !session.hasCall(savedSourceSelection.sourceCallId)) savedSourceSelection = undefined;
    },
    loadHistory(callId: string) {
      act(() => {selectedCallId = callId; session.loadHistory(callId); input.focus();});
    },
    loadLesson(step: ConsoleLessonStep) {
      act(() => {
        if (step.input !== undefined) session.loadPreset(operation.id, stringifyConsoleJson(step.input), step.needsRunSource, step.needsEventCursor);
        if (step.inputOverrides !== undefined) {
          const current: unknown = JSON.parse(session.snapshot().draft.inputText);
          if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('请先准备有效的 input 对象。');
          session.updateDraft(stringifyConsoleJson({...current, ...step.inputOverrides}));
        }
        message = step.notes ?? '已载入步骤，请检查参数后手工执行。';
        lessons.open = true; input.focus();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true; events.abort(); panel.remove();
    },
  };
}

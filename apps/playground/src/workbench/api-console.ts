import {CONSOLE_OPERATIONS, getConsoleOperation, MAX_CONSOLE_READ_PROPERTIES} from './api-console-catalog';
import {CONSOLE_LESSONS} from './api-console-presets';
import {consoleResultSource} from './api-console-session';
import type {ConsoleCall, ConsoleCapability, ConsoleFillSelection, ConsoleSession, ConsoleSnapshot} from './api-console-types';

/** The view owns DOM and object URLs; the session owns calls, drafts and Blobs. */
export function createApiConsole(container: HTMLElement, session: ConsoleSession) {
  const events = new AbortController();
  let disposed = false, composing = false, selectedCallId: string | undefined;
  let historyKey = '', sourcesKey = '', lastOperation = '', message = '';
  const urls = new Map<string, {blob: Blob; url: string}>();

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
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
    node.onclick = () => {if (!disposed) act(action);};
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
  const root = element('div', 'api-console');
  const heading = element('div', 'api-console-heading');
  const title = element('h2', '', 'API 调用台');
  const open = button('打开独立示例', 'open-example', () => session.openExample());
  heading.append(title, open);
  const exampleNote = element('p', 'api-console-note', '打开示例会切换项目并结束当前预览，原项目保留；不会自动运行。');
  const context = test(element('dl', 'api-console-context'), 'context');
  function contextRow(label: string) {
    const term = element('dt', '', label), value = element('dd'); context.append(term, value); return value;
  }
  const contextRows = ['编辑项目 / 版本', '主运行 / 源码版本', '运行归属 / 阶段', '待启动 attempt'].map(contextRow);
  const capabilityRows = ([
    ['observation', '运行时观察'], ['runtimeWrite', '原生属性写入'],
    ['runtimeProperties', '公开属性访问'], ['interaction', '截图与输入'],
  ] as const).map(([key, label]) => ({key, value: contextRow(label)}));
  const compatibility = element('p', 'api-console-note', 'Summer 风格输入子集 · 部分语义 · GodotAI typed-v1 结果；本地辅助单独标注。');
  const composer = element('section', 'api-console-composer');
  composer.setAttribute('aria-label', '构造 API 调用');
  const operationLabel = element('label', 'api-console-label', '操作');
  const operation = test(element('select'), 'operation');
  operation.id = 'api-console-operation'; operationLabel.htmlFor = operation.id;
  for (const [family, label] of [['summer', 'Summer 风格子集'], ['local', 'GodotAI 本地辅助']] as const) {
    const group = element('optgroup'); group.label = label;
    for (const item of CONSOLE_OPERATIONS.filter(item => item.family === family)) {
      const option = element('option', '', `${item.name} · ${item.title}`); option.value = item.id; group.append(option);
    }
    operation.append(group);
  }
  operation.addEventListener('change', () => act(() => session.selectOperation(operation.value)), {signal: events.signal});
  const description = element('p', 'api-console-description');
  const restrictions = element('details', 'api-console-limits');
  restrictions.append(element('summary', '', '支持参数与限制'));
  const parameterList = element('dl', 'api-console-parameters'), limitationList = element('ul');
  restrictions.append(parameterList, limitationList);
  const inputLabel = element('label', 'api-console-label', 'input 参数 JSON');
  const input = test(element('textarea'), 'input');
  input.id = 'api-console-input'; inputLabel.htmlFor = input.id;
  input.spellcheck = false; input.wrap = 'off'; input.rows = 8;
  input.setAttribute('aria-describedby', 'api-console-input-hint api-console-client-error');
  const hint = element('p', 'api-console-note', '只编辑 input；Ctrl/Cmd + Enter 执行。草稿仅保存在当前页面，选择预设和历史不会执行。');
  hint.id = 'api-console-input-hint';
  input.addEventListener('input', () => act(() => session.updateDraft(input.value)), {signal: events.signal});
  input.addEventListener('compositionstart', () => {composing = true;}, {signal: events.signal});
  input.addEventListener('compositionend', () => {composing = false;}, {signal: events.signal});
  input.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      // Never let the global source-build shortcut receive an API edit gesture.
      event.stopPropagation();
      if (composing || event.isComposing) return;
      event.preventDefault();
      if (!event.repeat && !execute.disabled) act(submit);
    }
  }, {signal: events.signal});
  const actions = element('div', 'api-console-actions');
  const preset = button('填入预设', 'preset', () => {
    const state = session.snapshot(), item = getConsoleOperation(state.operationId);
    if (!item) return;
    const value = item.createPreset(state.environment.anchor);
    session.loadPreset(item.id, JSON.stringify(value.input, null, 2));
    if (value.missing.length) message = `还需实际结果来源：${value.missing.join('、')}`;
  });
  const update = button('更新目标 / 填入上下文', 'update-target', () => session.updateTarget());
  const format = button('格式化 JSON', 'format', () => {
    const parsed: unknown = JSON.parse(input.value);
    session.updateDraft(JSON.stringify(parsed, null, 2));
  });
  function submit() { selectedCallId = undefined; return session.submit(); }
  const execute = button('执行', 'execute', submit); execute.classList.add('api-console-primary');
  const cancel = button('请求取消', 'cancel', () => session.cancel());
  cancel.title = '请求取消不撤销已经执行的写入或输入；以实际回执为准。';
  actions.append(preset, update, format, execute, cancel);
  const status = test(element('p', 'api-console-status'), 'status'); status.setAttribute('role', 'status');
  const error = test(element('p', 'api-console-error'), 'client-error'); error.id = 'api-console-client-error'; error.setAttribute('role', 'alert');
  const notification = test(element('p', 'api-console-note'), 'message'); notification.setAttribute('role', 'status');
  const requestDetails = element('details', 'api-console-request');
  requestDetails.append(element('summary', '', '完整请求（只读）'));
  const request = test(element('pre'), 'request');
  const copyRequest = button('复制请求', 'copy-request', () => copy(request.textContent ?? ''));
  requestDetails.append(copyRequest, request);
  composer.append(operationLabel, operation, description, restrictions, inputLabel, input, hint, actions, status, error, notification, requestDetails);

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
  const historyHeading = element('div', 'api-console-section-heading'); historyHeading.append(element('h3', '', '本页历史'));
  const clear = button('清空已结算记录', 'clear-history', () => session.clearSettled()); historyHeading.append(clear);
  const history = test(element('ol', 'api-console-history'), 'history');
  historySection.append(historyHeading, history);
  const lessons = element('details', 'api-console-lessons'); lessons.append(element('summary', '', '手工教学流程'));
  for (const lesson of CONSOLE_LESSONS) {
    const section = element('section'); section.append(element('h3', '', lesson.title), element('p', 'api-console-note', lesson.description));
    const steps = element('ol');
    for (const step of lesson.steps) {
      const row = element('li');
      const load = button(step.label, 'lesson-step', () => {
        session.selectOperation(step.operationId);
        if (step.input !== undefined) session.loadPreset(step.operationId, JSON.stringify(step.input, null, 2));
        if (step.inputOverrides !== undefined) {
          const current: unknown = JSON.parse(session.snapshot().draft.inputText);
          if (!current || typeof current !== 'object' || Array.isArray(current)) throw Error('请先把当前 input 修复为 JSON 对象，再填入教学参数。');
          // A partial edit keeps the binding of any target fields carried over from the draft.
          session.updateDraft(JSON.stringify({...current, ...step.inputOverrides}, null, 2));
        }
        message = step.notes ?? '已载入参数；请自行执行并观察结果。';
        input.focus();
      });
      load.dataset.lessonId = lesson.id; load.dataset.stepId = step.id; row.append(load);
      if (step.notes) row.append(element('p', 'api-console-note', step.notes));
      steps.append(row);
    }
    section.append(steps); lessons.append(section);
  }
  root.append(heading, exampleNote, context, compatibility, composer, resultSection, historySection, lessons);
  container.replaceChildren(root);

  async function copy(text: string) {
    try {await navigator.clipboard.writeText(text); message = '已复制';}
    catch {message = '无法访问剪贴板，请选择文本手动复制。';}
    if (!disposed) render();
  }
  function requestText(draft: {operationId: string; inputText: string}) {
    try {
      const item = getConsoleOperation(draft.operationId), value: unknown = JSON.parse(draft.inputText);
      return JSON.stringify(item?.family === 'summer' ? {op: item.name, input: value} : {method: item?.name ?? draft.operationId, input: value}, null, 2);
    } catch { return 'input JSON 尚未解析成功。'; }
  }
  function renderHistory(state: ConsoleSnapshot, selected?: ConsoleCall) {
    const key = JSON.stringify(state.history.map(call => [call.callId, call.phase, call.summary, call.settledAt]));
    if (key !== historyKey) {
      historyKey = key; history.replaceChildren();
      for (const call of [...state.history].reverse().sort((a, b) => b.submittedAt - a.submittedAt)) {
        const row = element('li'); row.dataset.callId = call.callId; row.dataset.phase = call.phase;
        const view = button(`${call.draft.operationId} · ${call.summary ?? call.phase}`, 'history-view', () => {selectedCallId = call.callId;});
        view.dataset.action = 'view-history'; view.setAttribute('aria-label', `查看 ${call.callId} ${call.draft.operationId}`);
        const load = button('载入参数', 'history-load', () => {selectedCallId = call.callId; session.loadHistory(call.callId); input.focus();});
        load.dataset.action = 'load-history'; row.append(view, load); history.append(row);
      }
      if (!state.history.length) history.append(element('li', 'api-console-note', '尚无调用。每次执行仅记录一条历史。'));
    }
    for (const row of history.children) {
      const active = (row as HTMLElement).dataset.callId === selected?.callId;
      row.classList.toggle('selected', active);
      row.querySelector('button')?.setAttribute('aria-pressed', String(active));
    }
    clear.disabled = !state.history.some(call => call.phase !== 'pending');
  }
  function renderSources(operationId: string, call?: ConsoleCall) {
    const facts = call?.resultFacts;
    const kind = consoleResultSource(operationId, facts);
    const key = kind && call ? `${call.callId}:${kind}` : '';
    if (key === sourcesKey) return;
    sourcesKey = key; sources.replaceChildren(); sources.hidden = !kind;
    if (!call || !facts || !kind) return;
    sources.append(element('h4', '', '使用此结果填参'), element('p', 'api-console-note', `来源 ${call.callId}；只填入当前所选操作，不会执行。`));
    const selection: ConsoleFillSelection = {sourceCallId: call.callId};
    let node: HTMLSelectElement | undefined, properties: HTMLSelectElement | undefined, stopped: HTMLSelectElement | undefined;
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
    }
    if (kind === 'properties' && facts.properties) {
      properties = select(`属性（每次最多 ${MAX_CONSOLE_READ_PROPERTIES} 项）`, 'source-properties');
      properties.multiple = true; properties.size = Math.min(4, facts.properties.length);
      for (const property of facts.properties) {
        const option = element('option', '', `${property.name} · ${property.type}`); option.value = property.name; properties.append(option);
      }
    }
    if (kind === 'stopped-run' && facts.stoppedRunIds) {
      stopped = select('已捕获的停止目标', 'source-run');
      const placeholder = element('option', '', '请选择原 run…'); placeholder.value = ''; stopped.append(placeholder);
      for (const runId of facts.stoppedRunIds) {const option = element('option', '', runId); option.value = runId; stopped.append(option);}
    }
    if (kind === 'attempt') sources.append(element('p', 'api-console-note', `attemptId: ${facts.attemptId}`));
    if (facts.run) sources.append(element('p', 'api-console-note', `runId: ${facts.run.identity.runId}`));
    if (kind === 'input' && facts.input) sources.append(element('p', 'api-console-note', `输入: ${facts.input.runId} / ${facts.input.operationId}`));
    const use = button('填入当前操作', 'use-result', () => {
      if (node) selection.nodePath = node.value;
      if (properties) selection.propertyNames = Array.from(properties.selectedOptions, option => option.value);
      if (stopped) selection.stoppedRunId = stopped.value;
      session.updateTarget(selection);
    });
    use.dataset.sourceId = call.callId;
    const propertyLimit = properties ? test(element('p', 'api-console-error', `每次最多 ${MAX_CONSOLE_READ_PROPERTIES} 项属性，请减少选择。`), 'source-property-limit') : undefined;
    if (propertyLimit) {propertyLimit.setAttribute('role', 'status'); sources.append(propertyLimit);}
    const readiness = () => {
      const count = properties?.selectedOptions.length ?? 0;
      const overLimit = count > MAX_CONSOLE_READ_PROPERTIES;
      if (propertyLimit) propertyLimit.hidden = !overLimit;
      use.disabled = !!node && !node.value || !!properties && (!count || overLimit) || !!stopped && !stopped.value;
    };
    for (const field of [node, properties, stopped]) if (field) field.onchange = readiness;
    readiness(); sources.append(use);
    if (facts.truncated) sources.append(element('p', 'api-console-note', '来源列表已截断；这里只能使用已保留的事实。'));
  }
  function renderAttachment(history: readonly ConsoleCall[], call?: ConsoleCall) {
    const live = new Set<string>();
    for (const entry of history) if (entry.attachmentId && session.getAttachment(entry.attachmentId)) live.add(entry.attachmentId);
    for (const [id, item] of urls) if (!live.has(id)) {URL.revokeObjectURL(item.url); urls.delete(id);}
    const id = call?.attachmentId, attachment = id ? session.getAttachment(id) : undefined;
    const key = id && attachment ? id : call?.attachmentReleased ? `${call.callId}:released` : '';
    if (attachments.dataset.attachmentKey === key) return;
    attachments.dataset.attachmentKey = key; attachments.replaceChildren(); attachments.hidden = !key;
    if (!id || !attachment) {
      if (call?.attachmentReleased) attachments.append(element('p', 'api-console-note', '附件已释放；实际截图结果与元数据保留在摘要中。'));
      return;
    }
    let saved = urls.get(id);
    if (!saved || saved.blob !== attachment.blob) {
      if (saved) URL.revokeObjectURL(saved.url);
      saved = {blob: attachment.blob, url: URL.createObjectURL(attachment.blob)}; urls.set(id, saved);
    }
    const figure = element('figure'), image = element('img'), caption = element('figcaption');
    image.src = saved.url; image.alt = `实际游戏截图 ${call!.callId}`;
    const metadata = attachment.metadata;
    caption.textContent = `${metadata.width} × ${metadata.height} · renderSerial ${metadata.renderSerial} · run ${metadata.run.runId} · release ${metadata.releaseId}`;
    figure.append(image, caption); attachments.append(figure);
  }
  function render() {
    if (disposed) return;
    const state = session.snapshot(), anchor = state.environment.anchor;
    const item = getConsoleOperation(state.operationId);
    operation.value = state.operationId;
    if (input.value !== state.draft.inputText) input.value = state.draft.inputText;
    if (lastOperation !== state.operationId) {
      lastOperation = state.operationId; description.textContent = item?.description ?? state.operationId;
      parameterList.replaceChildren(); limitationList.replaceChildren();
      for (const parameter of item?.parameters ?? []) parameterList.append(element('dt', '', parameter.name + (parameter.required ? ' *' : '')), element('dd', '', parameter.description));
      if (!item?.parameters.length) parameterList.append(element('dt', '', '无参数'), element('dd', '', 'input 使用 {}。'));
      for (const limit of item?.limitations ?? []) limitationList.append(element('li', '', limit));
    }
    contextRows[0].textContent = `${anchor.editorProjectId ?? '未选择'} / ${anchor.editorRevision ?? '—'}`;
    contextRows[1].textContent = `${anchor.activeRunId ?? '无主运行'} / ${anchor.activeRunRevision ?? '—'}`;
    contextRows[2].textContent = `${anchor.activeRunProjectId ?? '—'} / ${state.environment.activeRunState ?? '待确认'}`;
    contextRows[3].textContent = anchor.pendingAttemptId ?? '无';
    for (const {key, value} of capabilityRows) setText(value, capabilityText(state.environment.capabilities?.[key]));
    execute.disabled = state.owner !== null || !!state.pendingCallId;
    open.disabled = state.owner !== null;
    cancel.hidden = !state.pendingCallId || !state.cancellable;
    status.textContent = state.owner === 'replay' ? '自动验证正在运行；结束后可手工调用。' : state.owner === 'open-example' ? '正在准备独立示例…' : state.pendingCallId ? '请求处理中；可继续编辑下一份草稿。' : '手工执行；选择操作、载入参数或使用结果均不会自动调用。';
    status.dataset.phase = state.pendingCallId ? 'pending' : 'idle';
    error.textContent = state.clientError?.message ?? ''; error.hidden = !state.clientError;
    input.setAttribute('aria-invalid', String(state.clientError?.kind === 'json'));
    notification.textContent = message; notification.hidden = !message;
    setText(request, requestText(state.draft));
    const call = state.history.find(entry => entry.callId === selectedCallId) ?? [...state.history].reverse().sort((a, b) => b.submittedAt - a.submittedAt)[0];
    resultStatus.textContent = call ? `${call.callId} · ${call.draft.operationId} · ${call.summary ?? call.phase}` : '执行后在此显示原 API 的结果。';
    setText(result, call?.resultProjection ?? (call?.phase === 'pending' ? '等待原 API 结算…' : '尚无结果。'));
    result.dataset.phase = call?.phase ?? 'empty';
    copyResult.disabled = !call?.resultProjection;
    callDetails.hidden = !call; setText(callRequest, call ? requestText(call.draft) : '');
    renderHistory(state, call); renderSources(state.operationId, call); renderAttachment(state.history, call);
  }
  const unsubscribe = session.subscribe(render);
  render();
  return {
    focus() {if (!disposed) input.focus();},
    dispose() {
      if (disposed) return;
      disposed = true; unsubscribe(); events.abort();
      for (const item of urls.values()) URL.revokeObjectURL(item.url);
      urls.clear(); root.remove();
    },
  };
}

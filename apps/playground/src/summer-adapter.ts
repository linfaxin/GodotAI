import {
  propertyRecord, pathIsCanonical, validPropertyName, validRuntimeString, readRuntimeValue, snapshotRuntimePropertyData,
  type DescribeInput, type DescribeResult, type WriteInput, type WriteResult, type PublicResult,
  type RuntimePropertiesState, type RuntimeValue, type RuntimeType, type AccessError,
} from '@godot-js/engine/browser/dedicated/worker-runtime-properties';
import type {
  RuntimeSetInput, RuntimeSetResult, RuntimeTreeInput, RuntimeTreeSnapshot,
  RuntimeNodeInput, RuntimeNodeSnapshot, ScreenshotInput, GameScreenshot, ObservationResult, InteractionResult,
} from '@godot-js/engine/browser/dedicated/worker-runner';
import type {CallMethodInput, DescribeMethodsInput, MethodCallResult, MethodDescriptionResult, MethodFailure,
  RuntimeCallState, RuntimeMethodScalar, MethodOutcome} from '@godot-js/engine/browser/dedicated/worker-runner';
import {readGameProbeQuery, type GameProbeInput, type GameProbeResult} from '@godot-js/engine/browser/dedicated/worker-runner';
import {readInputScriptCommand, type InputScriptCommand, type InputScriptInput,
  type InputScriptResult} from '@godot-js/engine/browser/dedicated/worker-runner';
import {sameWorkerRun, type WorkerRunIdentity} from '@godot-js/engine/browser/dedicated/worker-protocol';
import {LIFECYCLE_KINDS, type LifecycleKind, type LifecycleQuery, type RecentLifecycleEvents,
  type WaitLifecycleEvents} from './lifecycle-events.ts';
import type {ProjectContextData, StopResult, SummerDiagnosticsData} from './playground-api';
import {SUMMER_OPERATION_SPECS as rules, SUMMER_TREE_LIMITS, SUMMER_COMPATIBILITY, type SummerOperation} from './summer-operation-spec.ts';
export {SUMMER_COMPATIBILITY} from './summer-operation-spec.ts';

type BackendFailure = Extract<RuntimeSetResult | ObservationResult<unknown> | InteractionResult<unknown> | StopResult | PublicResult<unknown> | MethodFailure | GameProbeResult | InputScriptResult, {ok: false}>;
export type BackendError = {code: BackendFailure['error']['code']; message: string; source?: AccessError['source']; [key: string]: unknown};
export type FacadeErrorCode = BackendError['code'] | 'outcome_unknown' | 'call_error' | 'result_unavailable';
export type BackendReply<T> = {ok: true; result: T} | {ok: false; error: BackendError};
export interface SummerContext {
  projectId: string | null;
  editorRevision: number;
  activeRunId: string | null;
  pendingAttemptId: string | null;
}
export interface SummerRun {
  state: string;
  projectId?: string;
  runtimeProperties?: RuntimePropertiesState;
  runtimeWrite?: {supported: boolean | null; ready: boolean};
}
export type SelectedRuntimeMethod = Readonly<Pick<CallMethodInput, 'runId' | 'path' | 'expectedInstanceId' | 'method' | 'methodToken'> & {
  parameterTypes: readonly RuntimeMethodScalar['type'][];
}>;
export interface SummerMethodBackend {
  context(): SummerContext;
  run(runId: string): BackendReply<WorkerRunIdentity & {projectId: string; releaseId: string; state: string; runtimeCall: RuntimeCallState}>;
  tree(input: RuntimeTreeInput, signal: AbortSignal | undefined, deadline: number): Promise<BackendReply<RuntimeTreeSnapshot>>;
  describe(input: DescribeMethodsInput, signal: AbortSignal | undefined, deadline: number): Promise<MethodDescriptionResult>;
  invoke(input: CallMethodInput, signal: AbortSignal | undefined, deadline: number): Promise<MethodCallResult>;
}
export interface SummerBackend {
  gameProbe?(input: GameProbeInput, signal?: AbortSignal): Promise<GameProbeResult>;
  inputScript?(input: InputScriptInput, signal?: AbortSignal): Promise<InputScriptResult>;
  runtimeMethods?: SummerMethodBackend;
  recentLifecycleEvents?(query: LifecycleQuery): BackendReply<RecentLifecycleEvents>;
  waitLifecycleEvents?(query: LifecycleQuery, timeoutMs: number, signal?: AbortSignal): Promise<BackendReply<WaitLifecycleEvents>>;
  captureContext(): SummerContext;
  getProjectContext(): BackendReply<ProjectContextData>;
  getDiagnostics?(): BackendReply<SummerDiagnosticsData>;
  play(input: {projectId: string; expectedEditorRevision: number}): BackendReply<{attemptId: string}>;
  cancelLaunch(attemptId: string): void;
  getBuild(input: {attemptId: string}): BackendReply<{preview?: {status: string; runId?: string}}>;
  getRun(input: {runId: string}): BackendReply<SummerRun>;
  stop(input: {runId: string}): StopResult;
  getRuntimeTree(input: RuntimeTreeInput, signal?: AbortSignal): Promise<BackendReply<RuntimeTreeSnapshot>>;
  inspectRuntimeNode(input: RuntimeNodeInput, signal?: AbortSignal): Promise<BackendReply<RuntimeNodeSnapshot>>;
  describeRuntimeProperties(input: DescribeInput, signal?: AbortSignal): Promise<PublicResult<DescribeResult>>;
  writeRuntimeProperty(input: WriteInput, signal?: AbortSignal): Promise<PublicResult<WriteResult>>;
  runtimeSet(input: RuntimeSetInput, signal?: AbortSignal): Promise<RuntimeSetResult>;
  screenshot(input: ScreenshotInput, signal?: AbortSignal): Promise<BackendReply<GameScreenshot>>;
}
export type CompletedWriteResult = Exclude<WriteResult, {outcome: 'unconfirmed'}>;
type LegacyWriteSuccess = Extract<RuntimeSetResult, {ok: true}>;
export type WriteData =
  | {route: 'runtime_properties'; payload: Extract<PublicResult<CompletedWriteResult>, {ok: true}>}
  | {route: 'legacy_write'; payload: Omit<LegacyWriteSuccess, 'result'> & {result: Exclude<LegacyWriteSuccess['result'], {outcome: 'unconfirmed'}>}};
export type PlayData = {accepted: true; state: 'pending'; attemptId: string; run: null; projectId: string; editorRevision: number};
export type RunningData = {playing: boolean; capturedRunId: string | null; pendingAttemptId: string | null};
export type StopData = {accepted: true; cancelledAttemptId: string | null; capturedRunId: string | null; pendingAttemptId: string | null;
  runs: {runId: string; receipt: StopResult}[]; no_target: boolean};
export type CallData = {route: 'runtime_call'; payload: {ok: true; receipt: Extract<MethodCallResult, {ok: true}>['receipt']; result: Extract<MethodOutcome, {outcome: 'returned'}>}};
export type SummerData = Extract<GameProbeResult, {ok: true}>['result'] | Extract<InputScriptResult, {ok: true}> |
  CallData | ProjectContextData | RuntimeTreeSnapshot | RuntimeNodeSnapshot | GameScreenshot | WriteData | PlayData | RunningData | StopData |
  RecentLifecycleEvents | WaitLifecycleEvents | SummerDiagnosticsData;
export type FacadeSuccess<T = SummerData> = {ok: true; status: 'done'; result: {data: T; godotai: {compatibility: typeof SUMMER_COMPATIBILITY}}};
export type FacadeFailure = {ok: false; error: {code: FacadeErrorCode; message: string; source?: AccessError['source']; retry: 'no';
  details: {godotai: {compatibility: typeof SUMMER_COMPATIBILITY; route?: 'runtime_properties' | 'legacy_write' | 'runtime_call';
    stage?: 'resolve' | 'describe' | 'invoke';
    receipt?: NonNullable<Extract<GameProbeResult, {ok: false}>['receipt']> | PublicResult<WriteResult> | RuntimeSetResult | MethodCallResult | MethodDescriptionResult | InputScriptResult; backendError?: BackendError;
    parameter?: string; unknownKeys?: string[]}}}};
export type FacadeReply<T = SummerData> = FacadeSuccess<T> | FacadeFailure;
export type SummerCallInput = {op: string; input?: Record<string, unknown>};

const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const vectorNumber = '[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?';
const vectorLiteral = new RegExp('^Vector2[\\t\\n\\r ]*\\([\\t\\n\\r ]*(' + vectorNumber + ')[\\t\\n\\r ]*,[\\t\\n\\r ]*(' + vectorNumber + ')[\\t\\n\\r ]*\\)$');
type Operation = SummerOperation;
type Validated = {op: Operation; input: Record<string, unknown>};

function validateInputScript(input: Record<string, unknown>): Validated | FacadeFailure {
  const data = snapshotRuntimePropertyData(input);
  if (!propertyRecord(data)) return localError('invalid_input', 'input');
  if (data.action !== 'script') return localError(
    typeof data.action === 'string' && ['record_start', 'record_stop', 'replay'].includes(data.action) ? 'unsupported' : 'invalid_input', 'action');
  if (data.clock !== undefined && data.clock !== 'frame') return localError(data.clock === 'ms' ? 'unsupported' : 'invalid_input', 'clock');
  if (data.wait !== undefined && data.wait !== true) return localError(data.wait === false ? 'unsupported' : 'invalid_input', 'wait');
  if (!Array.isArray(data.events) || !data.events.every(propertyRecord)) return localError('invalid_input', 'events');
  for (const [index, edge] of data.events.entries()) {
    const name = 'events[' + index + ']';
    if (edge.type !== 'action') return localError(
      typeof edge.type === 'string' && ['key', 'mouse_click', 'axis', 'raw'].includes(edge.type) ? 'unsupported' : 'invalid_input', name + '.type');
    for (const field of ['hold_ms', 'at_ms']) if (Object.hasOwn(edge, field)) return localError('unsupported', name + '.' + field);
    if (Object.keys(edge).some(key => !['type', 'action', 'pressed', 'at_frame', 'strength'].includes(key)))
      return localError('invalid_input', name);
    if (Object.hasOwn(edge, 'strength') && (index !== 0 || edge.strength !== 1))
      return localError(typeof edge.strength === 'number' && edge.strength >= 0 && edge.strength <= 1 ? 'unsupported' : 'invalid_input', name + '.strength');
  }
  if (data.events.length !== 2) return localError('invalid_input', 'events');
  const [press, release] = data.events;
  const command = readInputScriptCommand({actionName: press.action, pressOffset: Object.hasOwn(press, 'at_frame') ? press.at_frame : 0, releaseOffset: release.at_frame});
  if (!command || press.pressed !== true || release.pressed !== false || press.action !== release.action)
    return localError('invalid_input', 'events');
  return {op: 'engine.game_input', input: command};
}

const done = <T>(data: T): FacadeSuccess<T> => ({ok: true, status: 'done', result: {data, godotai: {compatibility: SUMMER_COMPATIBILITY}}});
function fail(code: FacadeErrorCode, message: string, detail: Omit<FacadeFailure['error']['details']['godotai'], 'compatibility'> = {},
  source?: AccessError['source']): FacadeFailure {
  return {ok: false, error: {code, message, ...(source ? {source} : {}), retry: 'no', details: {godotai: {compatibility: SUMMER_COMPATIBILITY, ...detail}}}};
}
function localError(code: FacadeErrorCode, parameter: string, message: string = code) {return fail(code, message, {parameter}, 'sdk');}
function backendFailure(reply: {ok: false; error: {code: BackendError['code']; message: string; source?: AccessError['source']}},
  detail: Omit<FacadeFailure['error']['details']['godotai'], 'compatibility' | 'backendError'> = {}): FacadeFailure {
  return fail(reply.error.code, reply.error.message, {...detail, backendError: reply.error}, reply.error.source);
}
function validate(raw: unknown): Validated | FacadeFailure {
  try {
    if (!propertyRecord(raw)) return localError('invalid_input', 'call', '需要操作与普通数据参数');
    const unknownTop = Object.keys(raw).filter(key => key !== 'op' && key !== 'input');
    if (unknownTop.length) return fail('invalid_input', '未知调用字段', {unknownKeys: unknownTop}, 'sdk');
    if (typeof raw.op !== 'string' || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(raw.op)) return localError('invalid_input', 'op');
    if (!Object.hasOwn(rules, raw.op)) return localError('unsupported', 'op', '当前未支持该操作');
    const op = raw.op as Operation, input = raw.input === undefined ? {} : raw.input;
    if (!propertyRecord(input)) return localError('invalid_input', 'input');
    const rule = rules[op], allowed = rule.allowed as readonly string[], unsupported = rule.unsupported as readonly string[];
    const unknownKeys = Object.keys(input).filter(key => !allowed.includes(key) && !unsupported.includes(key));
    if (unknownKeys.length) return fail('invalid_input', '未知操作参数', {unknownKeys}, 'sdk');
    for (const key of unsupported) if (Object.hasOwn(input, key)) return localError('unsupported', key, '当前不支持该参数');
    if (op === 'engine.get_diagnostics' && Object.hasOwn(input, 'includeAll')) {
      if (typeof input.includeAll !== 'boolean') return localError('invalid_input', 'includeAll');
      if (input.includeAll) return localError('unsupported', 'includeAll', '当前只读取有界诊断记录');
    }
    if (Object.hasOwn(input, 'instance') && input.instance !== 'main') return localError(typeof input.instance === 'string' ? 'unsupported' : 'invalid_input', 'instance');
    if (op === 'engine.game_input') return validateInputScript(input);
    if (op === 'engine.inspect_runtime_node' || op === 'engine.runtime_set' || op === 'engine.runtime_call' || Object.hasOwn(input, 'path')) {
      if (!pathIsCanonical(input.path)) return localError('invalid_input', 'path');
    }
    if (op === 'engine.game_probe') {
      const owned = snapshotRuntimePropertyData(input);
      if (!propertyRecord(owned)) return localError('invalid_input', 'input');
      const {props = [], tree, screenshot, max_dim: maxDimension} = owned;
      if (!Array.isArray(props) || props.length > 64) return localError('invalid_input', 'props');
      const properties = [];
      for (const prop of props) {
        if (typeof prop !== 'string') return localError('invalid_input', 'props');
        const [path, property, ...extra] = prop.split(':');
        if (extra.length || !pathIsCanonical(path) || !validPropertyName(property))
          return localError('invalid_input', 'props');
        properties.push({path, property});
      }
      if (props.length > 16) return localError('unsupported', 'props');
      if (maxDimension !== undefined) {
        if (typeof maxDimension !== 'number' || !Number.isSafeInteger(maxDimension) || maxDimension < 16 || maxDimension > 4096)
          return localError('invalid_input', 'max_dim');
        if (maxDimension > 1024) return localError('unsupported', 'max_dim');
      }
      if (propertyRecord(tree) && typeof tree.limit === 'number' && Number.isInteger(tree.limit) && tree.limit > 500 && tree.limit <= 4000)
        return localError('unsupported', 'tree.limit');
      const query = readGameProbeQuery({props: properties, screenshot, maxDimension, ...(tree !== undefined ? {tree} : {})});
      return query ? {op, input: query} : localError('invalid_input', 'input', '请检查探测参数和 4 KiB 的原生请求上限');
    }
    if (op === 'engine.get_runtime_tree') {
      for (const key of ['depth', 'limit'] as const) {
        const bounds = SUMMER_TREE_LIMITS[key];
        if (Object.hasOwn(input, key) && (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || (input[key] as number) < bounds.min)) return localError('invalid_input', key);
        if ((input[key] as number | undefined) !== undefined && (input[key] as number) > bounds.max) return localError('unsupported', key);
      }
    }
    if (op === 'engine.screenshot' && input.target !== 'game') return localError(typeof input.target === 'string' ? 'unsupported' : 'invalid_input', 'target');
    if (op === 'engine.runtime_set') {
      if (!validPropertyName(input.property)) return localError('invalid_input', 'property');
      if (input.property === 'script' || input.property === 'owner') return localError('unsupported', 'property');
      if (typeof input.value !== 'boolean' && typeof input.value !== 'number' && typeof input.value !== 'string' ||
        typeof input.value === 'number' && !Number.isFinite(input.value) || typeof input.value === 'string' && !validRuntimeString(input.value)) return localError('invalid_input', 'value');
    }
    if (op === 'engine.runtime_call') {
      if (!validPropertyName(input.method)) return localError('invalid_input', 'method');
      const args = Object.hasOwn(input, 'args') ? snapshotRuntimePropertyData(input.args) : [];
      if (!Array.isArray(args)) return localError('invalid_input', 'args');
      if (args.length > 8 || args.some(value => typeof value === 'string' ? !validRuntimeString(value) :
          typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'boolean'))
        return localError('bad_args', 'args');
      return {op, input: {...input, args}};
    }
    return {op, input: {...input}};
  } catch {return localError('invalid_input', 'input');}
}

export function summerGameProbeInputError(input: unknown): FacadeFailure['error'] | undefined {
  const checked = validate({op: 'engine.game_probe', input});
  return 'ok' in checked ? checked.error : undefined;
}

export function parseSummerValue(type: RuntimeType, value: unknown): RuntimeValue | undefined {
  if (type === 'vector2') {
    if (typeof value !== 'string') return;
    const match = vectorLiteral.exec(value);
    if (!match || match[0].length !== value.length) return;
    return readRuntimeValue({type, value: {x: Number(match[1]), y: Number(match[2])}});
  }
  return readRuntimeValue({type, value});
}

const methodNow = () => performance.timeOrigin + performance.now();

async function runtimeCall(backend: SummerMethodBackend, input: Record<string, unknown>, signal: AbortSignal | undefined,
  deadline: number, selected?: SelectedRuntimeMethod): Promise<FacadeReply> {
  const context = backend.context();
  const runId = context.activeRunId;
  const path = input.path as string, method = input.method as string, args = input.args as unknown[];
  const route = 'runtime_call' as const;
  const reject = (code: FacadeErrorCode, stage: 'resolve' | 'describe' | 'invoke', message: string = code) =>
    fail(code, message, {route, stage}, 'sdk');
  if (selected && (selected.path !== path || selected.method !== method)) return reject('binding_changed', 'resolve');
  if (selected && selected.runId !== runId) return reject('run_ended', 'resolve');
  if (!runId || !context.projectId) return reject('not_ready', 'resolve');
  const bound = backend.run(runId);
  if (!bound.ok) return backendFailure(bound, {route, stage: 'resolve'});
  const run = bound.result;
  if (run.projectId !== context.projectId) return reject('revision_conflict', 'resolve');
  if (run.state === 'stopping' || run.state === 'exited') return reject('run_ended', 'resolve');
  if (selected && selected.methodToken.releaseId !== run.releaseId) return reject('binding_changed', 'resolve');
  if (run.runtimeCall.supported === false) return reject('unsupported', 'resolve');
  if (!run.runtimeCall.ready) return reject('not_ready', 'resolve');

  function check(stage: 'resolve' | 'describe' | 'invoke') {
    if (methodNow() >= deadline) return reject('timeout', stage);
    if (signal && readAborted.call(signal)) return reject('cancelled', stage);
    const current = backend.context();
    if (current.projectId !== context.projectId) return reject('revision_conflict', stage);
    if (current.activeRunId !== runId) return reject('run_ended', stage);
    const live = backend.run(runId!);
    if (!live.ok) return backendFailure(live, {route, stage});
    if (!sameWorkerRun(run, live.result) || run.releaseId !== live.result.releaseId || live.result.state !== 'running')
      return reject('run_ended', stage);
  }

  let target = selected;
  if (!target) {
    const beforeTree = check('resolve');
    if (beforeTree) return beforeTree;
    const tree = await backend.tree({runId, path, depth: 0, limit: 1}, signal, deadline);
    if (!tree.ok) return backendFailure(tree, {route, stage: 'resolve'});
    if (!sameWorkerRun(run, tree.result.run) || tree.result.releaseId !== run.releaseId)
      return reject('dispatch_failed', 'resolve');
    const [node] = tree.result.nodes;
    if (tree.result.nodes.length !== 1 || node?.path !== path) return reject('node_not_found', 'resolve');

    const nodeTarget = {runId, path, expectedInstanceId: node.instanceId};
    const beforeDescribe = check('describe');
    if (beforeDescribe) return beforeDescribe;
    const description = await backend.describe({...nodeTarget, method}, signal, deadline);
    if (!description.ok) return backendFailure(description, {route, stage: 'describe', receipt: description});
    const receipt = description.receipt;
    const [descriptor] = description.result.methods;
    if (!sameWorkerRun(run, receipt.run) || receipt.releaseId !== run.releaseId || receipt.path !== path ||
        receipt.expectedInstanceId !== node.instanceId || description.result.methods.length !== 1 || descriptor?.method !== method)
      return reject('dispatch_failed', 'describe');
    target = {...nodeTarget, method, methodToken: descriptor.methodToken, parameterTypes: descriptor.parameterTypes};
  }
  const {parameterTypes, ...invocation} = target;
  if (parameterTypes.length !== args.length) return reject('bad_args', 'invoke');
  const typed: RuntimeMethodScalar[] = [];
  for (const [index, type] of parameterTypes.entries()) {
    const value = readRuntimeValue({type, value: args[index]});
    if (!value || value.type === 'vector2') return reject('bad_args', 'invoke', '参数与登记的类型不匹配');
    typed.push(value);
  }
  const beforeInvoke = check('invoke');
  if (beforeInvoke) return beforeInvoke;
  const response = await backend.invoke({...invocation, args: typed}, signal, deadline);
  if (!response.ok) return backendFailure(response, {route, stage: 'invoke', receipt: response});
  const result = response.result;
  if (result.outcome === 'returned') return done<CallData>({route, payload: {...response, result}});
  const code = result.outcome === 'threw' ? 'call_error' : result.outcome === 'unconfirmed' ? 'outcome_unknown' : 'result_unavailable';
  const message = result.outcome === 'threw' ? '脚本方法已执行并抛出异常' :
    result.outcome === 'unconfirmed' ? '调用可能已执行，结果未确认' : '脚本方法已返回，返回值无法编码';
  return fail(code, message, {route, stage: 'invoke', receipt: response});
}

const OTHER_SUMMER_EVENT_KINDS = ['op.applied', 'op.failed', 'script.error', 'scene.saved', 'scene.opened',
  'import.completed', 'selection.changed', 'snapshot.published'];

function readLifecycleQuery(input: Record<string, unknown>, wait: boolean):
  {query: LifecycleQuery; timeoutMs: number} | FacadeFailure {
  const limitKey = wait ? 'max_events' : 'limit';
  const limit = input[limitKey] === undefined ? (wait ? 20 : 50) : input[limitKey];
  const {since, stream_id, kinds = [], timeout_seconds: timeout = 30} = input;
  if (since !== undefined && (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0))
    return localError('invalid_input', 'since');
  if (stream_id !== undefined && (typeof stream_id !== 'string' || !stream_id.length || stream_id.length > 256 || since === undefined))
    return localError('invalid_input', 'stream_id', 'stream_id 需要与 since 一起提交');
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)
    return localError('invalid_input', limitKey);
  if (typeof timeout !== 'number' || !Number.isFinite(timeout))
    return localError('invalid_input', 'timeout_seconds');
  const ownedKinds = snapshotRuntimePropertyData(kinds);
  if (!Array.isArray(ownedKinds)) return localError('invalid_input', 'kinds');
  const selected = new Set<LifecycleKind>();
  for (const raw of ownedKinds) {
    if (typeof raw !== 'string' || !raw.length) return localError('invalid_input', 'kinds');
    const kind = raw.trim() as LifecycleKind;
    if (!kind) continue;
    if (!LIFECYCLE_KINDS.includes(kind)) return localError(
      OTHER_SUMMER_EVENT_KINDS.includes(kind) ? 'unsupported' : 'invalid_input', 'kinds',
      `当前生命周期事件类型为 ${LIFECYCLE_KINDS.join('、')}`);
    selected.add(kind);
  }
  return {
    query: {since, stream_id, kinds: [...selected], limit: Math.min(limit, wait ? 500 : 200)},
    timeoutMs: Math.min(120, Math.max(1, Math.round(timeout))) * 1000,
  };
}

/** The dispatcher binds each call once; it never re-reads the active run after an await. */
export function createSummerDispatcher(backend: SummerBackend) {
  return async (raw: unknown, signal?: AbortSignal, selected?: SelectedRuntimeMethod): Promise<FacadeReply> => {
    const methodDeadline = methodNow() + 5000;
    const checked = validate(raw);
    if ('ok' in checked) return checked;
    const {op, input} = checked;
    try {
      if (signal !== undefined && readAborted.call(signal)) return localError('cancelled', 'signal');
    } catch {return localError('invalid_input', 'signal');}
    if (op === 'engine.runtime_call') return backend.runtimeMethods ?
      runtimeCall(backend.runtimeMethods, input, signal, methodDeadline, selected) : localError('unsupported', 'runtimeCall');
    if (op === 'engine.get_diagnostics') {
      const response = backend.getDiagnostics?.();
      return response === undefined ? localError('unsupported', 'diagnostics') :
        response.ok ? done(response.result) : backendFailure(response);
    }
    if (op === 'engine.recent_events' || op === 'engine.wait_for_event') {
      const wait = op === 'engine.wait_for_event';
      const prepared = readLifecycleQuery(input, wait);
      if ('ok' in prepared) return prepared;
      const response = wait
        ? await backend.waitLifecycleEvents?.(prepared.query, prepared.timeoutMs, signal)
        : backend.recentLifecycleEvents?.(prepared.query);
      return response === undefined ? localError('unsupported', 'events') :
        response.ok ? done(response.result) : backendFailure(response);
    }
    const context = {...backend.captureContext()};
    if (op === 'engine.get_project_context') {
      const response = backend.getProjectContext();
      return response.ok ? done(response.result) : backendFailure(response);
    }
    if (op === 'engine.play') {
      if (!context.projectId) return localError('not_ready', 'project');
      const response = backend.play({projectId: context.projectId, expectedEditorRevision: context.editorRevision});
      return response.ok ? done<PlayData>({accepted: true, state: 'pending', attemptId: response.result.attemptId, run: null,
        projectId: context.projectId, editorRevision: context.editorRevision}) : backendFailure(response);
    }
    if (op === 'engine.stop') {
      const pendingAttemptId = context.pendingAttemptId, capturedRunId = context.activeRunId;
      if (pendingAttemptId) backend.cancelLaunch(pendingAttemptId);
      const ids = new Set<string>();
      if (capturedRunId) ids.add(capturedRunId);
      if (pendingAttemptId) {
        const build = backend.getBuild({attemptId: pendingAttemptId});
        if (build.ok && build.result.preview?.status === 'session-created' && build.result.preview.runId) ids.add(build.result.preview.runId);
      }
      const runs = [...ids].map(runId => ({runId, receipt: backend.stop({runId})}));
      return done<StopData>({accepted: true, cancelledAttemptId: pendingAttemptId, capturedRunId, pendingAttemptId, runs,
        no_target: pendingAttemptId === null && runs.length === 0});
    }
    const runId = context.activeRunId;
    if (op === 'engine.is_running') {
      const run = runId ? backend.getRun({runId}) : undefined;
      return done<RunningData>({playing: !!run?.ok && run.result.state === 'running', capturedRunId: runId, pendingAttemptId: context.pendingAttemptId});
    }
    if (!runId) return localError('not_ready', 'run');
    const run = backend.getRun({runId});
    if (!run.ok) return backendFailure(run);
    if (run.result.state === 'stopping' || run.result.state === 'exited') return localError('run_ended', 'run');
    if (op === 'engine.game_input') {
      if (!context.projectId || run.result.projectId !== context.projectId) return localError('revision_conflict', 'run');
      if (context.pendingAttemptId || run.result.state !== 'running') return localError('not_ready', 'run');
      if (!backend.inputScript) return localError('unsupported', 'inputScript');
      const response = await backend.inputScript({runId, ...(input as InputScriptCommand)}, signal);
      return response.ok ? done(response) : backendFailure(response, {receipt: response});
    }
    if (op === 'engine.game_probe') {
      if (!context.projectId || run.result.projectId !== context.projectId) return localError('revision_conflict', 'run');
      if (!backend.gameProbe) return localError('unsupported', 'gameProbe');
      const response = await backend.gameProbe({runId, ...input}, signal);
      return response.ok ? done(response.result) : backendFailure(response, {...(response.receipt ? {receipt: response.receipt} : {})});
    }
    if (op === 'engine.get_runtime_tree') {
      const response = await backend.getRuntimeTree({runId, ...(input.path ? {path: input.path as string} : {}),
        depth: (input.depth ?? SUMMER_TREE_LIMITS.depth.default) as number, limit: (input.limit ?? SUMMER_TREE_LIMITS.limit.default) as number}, signal);
      return response.ok ? done(response.result) : backendFailure(response);
    }
    if (op === 'engine.inspect_runtime_node') {
      const response = await backend.inspectRuntimeNode({runId, path: input.path as string, properties: ['position', 'rotation', 'visible']}, signal);
      return response.ok ? done(response.result) : backendFailure(response);
    }
    if (op === 'engine.screenshot') {
      const response = await backend.screenshot({runId}, signal);
      return response.ok ? done(response.result) : backendFailure(response);
    }
    const path = input.path as string, property = input.property as string;
    // Route is fixed from the bound run, before metadata lookup or any effectful access.
    const properties = run.result.runtimeProperties ? {...run.result.runtimeProperties} : undefined;
    const legacy = run.result.runtimeWrite ? {...run.result.runtimeWrite} : undefined;
    if (properties?.supported === null || properties?.supported === true && !properties.ready) return localError('not_ready', 'runtimeProperties');
    const route = properties?.supported === true && properties.ready ? 'runtime_properties' :
      properties?.supported === false && legacy?.supported === true && legacy.ready ? 'legacy_write' : undefined;
    if (!route) return localError(properties?.supported === false ? 'unsupported' : 'not_ready', 'runtimeProperties');
    if (route === 'legacy_write' && property !== 'position') return localError('unsupported', 'property');
    const tree = await backend.getRuntimeTree({runId, path, depth: 0, limit: 1}, signal);
    if (!tree.ok) return backendFailure(tree);
    const node = tree.result.nodes.find(item => item.path === path);
    if (!node || tree.result.run.runId !== runId) return localError('node_not_found', 'path');
    const target = {runId, path, expectedInstanceId: node.instanceId};
    if (route === 'legacy_write') {
      const value = parseSummerValue('vector2', input.value);
      if (!value || value.type !== 'vector2') return localError('type_mismatch', 'value');
      const response = await backend.runtimeSet({...target, property: 'position', value: value.value}, signal);
      if (!response.ok) return backendFailure(response, {route, receipt: response});
      return response.result.outcome === 'unconfirmed' ? fail('outcome_unknown', '写入可能已执行，结果未确认', {route, receipt: response}) : done<WriteData>({route, payload: {...response, result: response.result}});
    }
    const description = await backend.describeRuntimeProperties({...target, names: [property]}, signal);
    if (!description.ok) return backendFailure(description);
    if (description.result.mode !== 'names') return localError('dispatch_failed', 'description');
    const item = description.result.properties.find(entry => entry.name === property);
    if (!item || item.status === 'unresolved') return localError('not_ready', 'property');
    if (item.status === 'absent') return localError('property_not_found', 'property');
    const descriptor = item.descriptor;
    if (descriptor.writeAccess.status === 'unsupported' || descriptor.type === null) return localError(descriptor.writeAccess.status === 'unsupported' && descriptor.writeAccess.reason === 'read_only' ? 'property_read_only' : 'unsupported', 'property');
    const typed = parseSummerValue(descriptor.type, input.value);
    if (!typed) return localError('type_mismatch', 'value');
    const response = await backend.writeRuntimeProperty({...target, property, value: typed}, signal);
    if (!response.ok) return backendFailure(response, {route, receipt: response});
    return response.result.outcome === 'unconfirmed' ? fail('outcome_unknown', '属性访问可能已执行，结果未确认', {route, receipt: response}) : done<WriteData>({route, payload: {...response, result: response.result}});
  };
}

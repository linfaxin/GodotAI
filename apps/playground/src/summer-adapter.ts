import {
  propertyRecord, pathIsCanonical, validPropertyName, validRuntimeString, readRuntimeValue,
  type DescribeInput, type DescribeResult, type WriteInput, type WriteResult, type PublicResult,
  type RuntimePropertiesState, type RuntimeValue, type RuntimeType, type AccessError,
} from '@godot-js/engine/browser/dedicated/worker-runtime-properties';
import type {
  RuntimeSetInput, RuntimeSetResult, RuntimeTreeInput, RuntimeTreeSnapshot,
  RuntimeNodeInput, RuntimeNodeSnapshot, ScreenshotInput, GameScreenshot, ObservationResult, InteractionResult,
} from '@godot-js/engine/browser/dedicated/worker-runner';
import type {ProjectContextData, StopResult} from './playground-api';

type BackendFailure = Extract<RuntimeSetResult | ObservationResult<unknown> | InteractionResult<unknown> | StopResult | PublicResult<unknown>, {ok: false}>;
export type BackendError = {code: BackendFailure['error']['code']; message: string; source?: AccessError['source']; [key: string]: unknown};
export type FacadeErrorCode = BackendError['code'] | 'outcome_unknown';
export type BackendReply<T> = {ok: true; result: T} | {ok: false; error: BackendError};
export interface SummerContext {
  projectId: string | null;
  editorRevision: number;
  activeRunId: string | null;
  pendingAttemptId: string | null;
}
export interface SummerRun {
  state: string;
  runtimeProperties?: RuntimePropertiesState;
  runtimeWrite?: {supported: boolean | null; ready: boolean};
}
export interface SummerBackend {
  captureContext(): SummerContext;
  getProjectContext(): BackendReply<ProjectContextData>;
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
export const SUMMER_COMPATIBILITY = Object.freeze({input: 'subset' as const, semantics: 'partial' as const,
  payload: 'godotai-typed-v1' as const, summerNativeFixture: false as const});
export type CompletedWriteResult = Exclude<WriteResult, {outcome: 'unconfirmed'}>;
type LegacyWriteSuccess = Extract<RuntimeSetResult, {ok: true}>;
export type WriteData =
  | {route: 'runtime_properties'; payload: Extract<PublicResult<CompletedWriteResult>, {ok: true}>}
  | {route: 'legacy_write'; payload: Omit<LegacyWriteSuccess, 'result'> & {result: Exclude<LegacyWriteSuccess['result'], {outcome: 'unconfirmed'}>}};
export type PlayData = {accepted: true; state: 'pending'; attemptId: string; run: null; projectId: string; editorRevision: number};
export type RunningData = {playing: boolean; capturedRunId: string | null; pendingAttemptId: string | null};
export type StopData = {accepted: true; cancelledAttemptId: string | null; capturedRunId: string | null; pendingAttemptId: string | null;
  runs: {runId: string; receipt: StopResult}[]; no_target: boolean};
export type SummerData = ProjectContextData | RuntimeTreeSnapshot | RuntimeNodeSnapshot | GameScreenshot | WriteData | PlayData | RunningData | StopData;
export type FacadeSuccess<T = SummerData> = {ok: true; status: 'done'; result: {data: T; godotai: {compatibility: typeof SUMMER_COMPATIBILITY}}};
export type FacadeFailure = {ok: false; error: {code: FacadeErrorCode; message: string; source?: AccessError['source']; retry: 'no';
  details: {godotai: {compatibility: typeof SUMMER_COMPATIBILITY; route?: 'runtime_properties' | 'legacy_write';
    receipt?: PublicResult<WriteResult> | RuntimeSetResult; backendError?: BackendError;
    parameter?: string; unknownKeys?: string[]}}}};
export type FacadeReply<T = SummerData> = FacadeSuccess<T> | FacadeFailure;
export type SummerCallInput = {op: string; input?: Record<string, unknown>};

const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const vectorNumber = '[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?';
const vectorLiteral = new RegExp('^Vector2[\\t\\n\\r ]*\\([\\t\\n\\r ]*(' + vectorNumber + ')[\\t\\n\\r ]*,[\\t\\n\\r ]*(' + vectorNumber + ')[\\t\\n\\r ]*\\)$');
const rules = {
  'engine.get_project_context': {allowed: [], unsupported: ['include', 'settingsPrefix', 'settingsPrefixes']},
  'engine.play': {allowed: ['instance'], unsupported: ['scene', 'mode', 'focus', 'deterministic', 'seed', 'fixed_fps', 'time_scale', 'speed', 'players', 'spectators', 'queue']},
  'engine.stop': {allowed: ['instance'], unsupported: []},
  'engine.is_running': {allowed: [], unsupported: []},
  'engine.get_runtime_tree': {allowed: ['path', 'depth', 'limit'], unsupported: ['maxCharacters']},
  'engine.inspect_runtime_node': {allowed: ['path'], unsupported: ['maxCharacters']},
  'engine.runtime_set': {allowed: ['path', 'property', 'value', 'instance'], unsupported: ['field']},
  'engine.screenshot': {allowed: ['target'], unsupported: ['scenePath', 'framing', 'bookmark_name', 'size', 'nodePath', 'camera_path', 'camera_position', 'camera_look_at', 'fov', 'marks', 'max_marks', 'compare_previous', 'update_previous']},
} as const;
type Operation = keyof typeof rules;
type Validated = {op: Operation; input: Record<string, unknown>};

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
    if (Object.hasOwn(input, 'instance') && input.instance !== 'main') return localError(typeof input.instance === 'string' ? 'unsupported' : 'invalid_input', 'instance');
    if (op === 'engine.inspect_runtime_node' || op === 'engine.runtime_set' || Object.hasOwn(input, 'path')) {
      if (!pathIsCanonical(input.path)) return localError('invalid_input', 'path');
    }
    if (op === 'engine.get_runtime_tree') {
      for (const [key, max] of [['depth', 8], ['limit', 500]] as const) {
        if (Object.hasOwn(input, key) && (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || (input[key] as number) < 1)) return localError('invalid_input', key);
        if ((input[key] as number | undefined) !== undefined && (input[key] as number) > max) return localError('unsupported', key);
      }
    }
    if (op === 'engine.screenshot' && input.target !== 'game') return localError(typeof input.target === 'string' ? 'unsupported' : 'invalid_input', 'target');
    if (op === 'engine.runtime_set') {
      if (!validPropertyName(input.property)) return localError('invalid_input', 'property');
      if (input.property === 'script' || input.property === 'owner') return localError('unsupported', 'property');
      if (typeof input.value !== 'boolean' && typeof input.value !== 'number' && typeof input.value !== 'string' ||
        typeof input.value === 'number' && !Number.isFinite(input.value) || typeof input.value === 'string' && !validRuntimeString(input.value)) return localError('invalid_input', 'value');
    }
    return {op, input: {...input}};
  } catch {return localError('invalid_input', 'input');}
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

/** The dispatcher binds each call once; it never re-reads the active run after an await. */
export function createSummerDispatcher(backend: SummerBackend) {
  return async (raw: unknown, signal?: AbortSignal): Promise<FacadeReply> => {
    const checked = validate(raw);
    if ('ok' in checked) return checked;
    const {op, input} = checked;
    try {
      if (signal !== undefined && readAborted.call(signal)) return localError('cancelled', 'signal');
    } catch {return localError('invalid_input', 'signal');}
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
    if (op === 'engine.get_runtime_tree') {
      const response = await backend.getRuntimeTree({runId, ...(input.path ? {path: input.path as string} : {}),
        depth: (input.depth ?? 3) as number, limit: (input.limit ?? 500) as number}, signal);
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

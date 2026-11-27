import type {LifecycleQuery, WaitLifecycleEvents} from './lifecycle-events.ts';
import type {FacadeReply, SelectedRuntimeMethod, SummerMethodBackend} from './summer-adapter';
import type {
  createDebugRecorder, DebugBuild, DebugCheck, DebugRun, DebugContext, DebugExit, ReadRunEventsOptions,
} from './debug-api';
import type {WorkerRunIdentity} from '@godot-js/engine/browser/dedicated/worker-protocol';
import {snapshotRuntimePropertyData, prepareRuntimeProperties, runtimePropertiesError, type DescribeInput, type ReadInput, type WriteInput, type PropertyKind, type PropertyResult, prepareRuntimeObservation, prepareRuntimeSet, runtimeWriteError, type GameInput, type GameScreenshot, type InteractionResult,
  type ObservationResult, type PreparedRuntimeObservation, type RuntimeNodeInput, type RuntimeTreeInput, type ScreenshotInput,
  type RuntimeSetInput, type RuntimeSetResult, type WaitForInput, type WorkerPreviewRunner,
  gameProbeError, prepareGameProbe, type GameProbeInput, type GameProbeResult, runtimeMethodError, type DescribeMethodsInput, type CallMethodInput,
  inputScriptFailure, type InputScriptInput} from '@godot-js/engine/browser/dedicated/worker-runner';

type Recorder = ReturnType<typeof createDebugRecorder>;
type ErrorCode = 'invalid_input' | 'not_found' | 'invalid_cursor' | 'revision_conflict' |
  'not_ready' | 'unsupported' | 'busy' | 'cancelled';
type ToolError = {ok: false; error: {code: ErrorCode; message: string}};
type ProjectInput = {projectId: string; expectedEditorRevision: number};
type DiagnosticInput = {projectId: string; editorRevision: number; checkId?: string; attemptId?: string; runId?: string; path?: string};
type DiagnosticRecordsInput = Pick<DiagnosticInput, 'projectId' | 'editorRevision' | 'checkId' | 'attemptId'>;
type ExitDiagnostic = Pick<NonNullable<DebugExit['report']['diagnostic']>, 'source' | 'message' | 'name' | 'filename' | 'line' | 'column'>;
export interface SummerDiagnosticsData {
  projectId: string;
  editorRevision: number;
  check: Pick<DebugCheck, 'checkId' | 'status' | 'sourceHash' | 'diagnostics' | 'error'> | null;
  build: Pick<DebugBuild, 'attemptId' | 'status' | 'sourceHash' | 'diagnostics' | 'error' | 'artifact' | 'preview'> | null;
  run: null | {availability: 'unavailable'; runId: string; attemptId: string} |
    {availability: 'retained'; identity: WorkerRunIdentity; attemptId: string; releaseId: string; artifactId: string;
      state: DebugRun['state']; exit: null | {evidence: DebugExit['evidence']; reason: DebugExit['report']['reason']; diagnostic: ExitDiagnostic | null}};
}
export type SummerScriptErrorsData = DebugCheck & {path: string};
type WaitInput = ({attemptId: string; runId?: never} | {runId: string; attemptId?: never}) & {
  until: 'running' | 'exited';
  timeoutMs?: number;
};
type WaitResult = {
  outcome: 'reached' | 'no_session' | 'exited_before_condition' | 'timeout';
  build?: DebugBuild;
  run?: DebugRun;
};
type Capability = 'available' | 'not_ready' | 'unsupported';
export interface ProjectContextData extends DebugContext {
  capabilities: {check: Capability; play: Capability; wait_for_event: 'available'; stop: Capability};
}
export type StopResult = ToolError | {ok: true; result:
  {status: 'stopping'; runId: string} | {status: 'exited'; runId: string; exit: DebugExit}};
type Observation = Pick<WorkerPreviewRunner, 'observationState' | 'getRuntimeTree' | 'inspectRuntimeNode'>;
type ObservationKind = PreparedRuntimeObservation['query']['kind'];
type ObservationInput<Kind extends ObservationKind> = Pick<PreparedRuntimeObservation, 'runId' | 'timeoutMs'> &
  Extract<PreparedRuntimeObservation['query'], {kind: Kind}>;

interface Actions {
  supportsProject(): boolean;
  check(path?: string): Promise<DebugCheck> | undefined;
  hasScript(path: string): boolean;
  play(): string | undefined;
  stopRun(runId: string): Promise<unknown> | undefined;
  interaction?(): Pick<WorkerPreviewRunner, 'interactionState' | 'screenshot' | 'gameInput' | 'waitForInput'> | undefined;
  observation?(): Observation | undefined;
  runtimeWrite?(): Pick<WorkerPreviewRunner, 'runtimeWriteState' | 'setRuntimeProperty'> | undefined;
  runtimeProperties?(): Pick<WorkerPreviewRunner, 'runtimePropertiesState' | 'describeRuntimeProperties' | 'readRuntimeProperties' | 'writeRuntimeProperty'> | undefined;
  gameProbe?(): Pick<WorkerPreviewRunner, 'gameProbe' | 'gameProbeState'> | undefined;
  inputScript?(): Pick<WorkerPreviewRunner, 'runGameInputScript' | 'inputScriptState'> | undefined;
  runtimeCall?(): Pick<WorkerPreviewRunner, 'runtimeCallState' | 'describeRuntimeMethods' | 'callRuntimeMethod' | 'getRuntimeTree'> | undefined;
  summerCall?(input: unknown, signal?: AbortSignal, selected?: SelectedRuntimeMethod): Promise<FacadeReply>;
}

export interface PlaygroundApiCall {
  name: string;
  input: unknown;
  result: unknown;
}

const ok = <T>(result: T) => ({ok: true as const, result});
const fail = (code: ErrorCode, message: string): ToolError => ({ok: false, error: {code, message}});
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const isRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const MAX_WAITERS = 16;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

function projectDiagnosticRun(run: DebugRun): Extract<SummerDiagnosticsData['run'], {availability: 'retained'}> {
  const {runId, revision, buildKey, generation, documentId, workerId, runConfigurationHash, state, attemptId} = run;
  const exit = run.exit;
  const diagnostic = exit?.report.diagnostic;
  return {
    availability: 'retained',
    identity: {runId, revision, buildKey, generation, documentId, workerId, runConfigurationHash},
    attemptId, state, releaseId: run.release.releaseId, artifactId: run.artifact.artifactId,
    exit: exit ? {evidence: exit.evidence, reason: exit.report.reason, diagnostic: diagnostic ? {
      source: diagnostic.source, message: diagnostic.message, name: diagnostic.name,
      filename: diagnostic.filename, line: diagnostic.line, column: diagnostic.column,
    } : null} : null,
  };
}

export function createPlaygroundApi(recorder: Recorder, actions: Actions) {
  const debug = recorder.api;
  const observers = new Set<(call: PlaygroundApiCall) => void>();
  const waiting = new Set<() => void>();
  let waitsDisposed = false;

  function cancelWaits() {
    for (const cancel of waiting) cancel();
  }

  const invalidCursor = () => fail('invalid_cursor', '游标不属于当前页面事件流或超出范围');

  function recentLifecycleEvents(query: LifecycleQuery) {
    return recorder.lifecycle.accepts(query) ? ok(recorder.lifecycle.recent(query)) : invalidCursor();
  }

  function waitLifecycleEvents(query: LifecycleQuery, timeoutMs: number, signal?: AbortSignal):
    Promise<ReturnType<typeof ok<WaitLifecycleEvents>> | ToolError> {
    const log = recorder.lifecycle;
    if (!log.accepts(query)) return Promise.resolve(invalidCursor());
    if (waitsDisposed || (signal && readAborted.call(signal)))
      return Promise.resolve(fail('cancelled', '已取消等待'));
    if (waiting.size >= MAX_WAITERS) return Promise.resolve(fail('busy', '等待操作已达上限'));
    const since = query.since ?? log.head();
    const start = performance.now();
    return new Promise(resolve => {
      let settled = false;

      function finish(reply: ReturnType<typeof ok<WaitLifecycleEvents>> | ToolError) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        waiting.delete(cancel);
        if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', cancel);
        resolve(reply);
      }

      const cancel = () => finish(fail('cancelled', '已取消等待'));
      function scan(timedOut = false) {
        if (settled) return;
        const page = log.read(since, query.kinds, query.limit);
        const matched = page.events.length > 0;
        if (matched || timedOut) finish(ok({
          ...page, matched, timed_out: !matched, waited_ms: performance.now() - start,
        }));
      }

      const unsubscribe = recorder.subscribe(scan);
      const timer = setTimeout(() => scan(true), timeoutMs);
      waiting.add(cancel);
      if (signal) EventTarget.prototype.addEventListener.call(signal, 'abort', cancel, {once: true});
      scan();
    });
  }

  function publish(name: string, input: unknown, result: unknown) {
    for (const observer of observers) {
      try { observer({name, input, result}); } catch { /* Diagnostics cannot change tool execution. */ }
    }
  }

  function tool<Args extends unknown[], Result>(name: string, execute: (...args: Args) => Result,
    projectResult?: (value: Awaited<Result>) => unknown, projectInput?: (input: unknown) => unknown) {
    return (...args: Args): Result => {
      const result = execute(...args);
      if (observers.size) {
        // Snapshot parameters at submission. Invalid or excessive inputs need no full UI copy.
        let input: unknown;
        try {
          const json = JSON.stringify(snapshotRuntimePropertyData(projectInput ? projectInput(args[0]) : args[0]));
          input = json === undefined ? {} : json.length <= 4096 ? JSON.parse(json) : {omitted: true};
        } catch { input = {omitted: true}; }
        const observed = (value: Awaited<Result>) => publish(name, input, projectResult ? projectResult(value) : value);
        if (result instanceof Promise) void result.then(observed, () => {});
        else observed(result as Awaited<Result>);
      }
      return result;
    };
  }

  function getProjectContext(): {ok: true; result: ProjectContextData} {
    const context = debug.getContext().result;
    const check: Capability = context.release.status === 'unsupported' ||
      context.projectId !== null && !actions.supportsProject() ? 'unsupported' :
      context.release.status === 'available' && context.projectId !== null ? 'available' : 'not_ready';
    const play: Capability = check !== 'available' ? check :
      context.preview.status === 'available' ? 'available' :
      context.preview.status === 'unsupported' ? 'unsupported' : 'not_ready';
    return ok({...context, capabilities: {check, play, wait_for_event: 'available' as const, stop: context.activeRunId ? 'available' as const : play}});
  }

  function admit(input: ProjectInput, action: 'check' | 'play') {
    if (!isId(input?.projectId) || !isRevision(input.expectedEditorRevision)) {
      return fail('invalid_input', '需要项目 ID 和有效的编辑版本');
    }
    const {projectId, editorRevision, capabilities} = getProjectContext().result;
    if (projectId !== input.projectId || editorRevision !== input.expectedEditorRevision) {
      return fail('revision_conflict', '项目或编辑版本已变化，请重新读取项目上下文');
    }
    return capabilities[action] === 'available' ? undefined :
      fail(capabilities[action], '当前项目的执行环境不可用');
  }

  function diagnosticRecords({projectId, editorRevision, checkId, attemptId}: DiagnosticRecordsInput) {
    const queriedBuild = attemptId === undefined ? undefined : debug.getBuild(attemptId);
    if (queriedBuild && !queriedBuild.ok) return queriedBuild;
    const build = queriedBuild?.result ?? recorder.getBuildForRevision(projectId, editorRevision);
    const check = checkId === undefined ? recorder.getCheckForRevision(projectId, editorRevision) : recorder.getCheck(checkId);
    if (checkId !== undefined && !check) return fail('not_found', '检查记录不可用');
    if ([check, build].some(item => item && (item.projectId !== projectId || item.editorRevision !== editorRevision))) {
      return fail('revision_conflict', '诊断记录不属于同一项目版本或构建');
    }
    return ok({check, build});
  }

  function diagnostics(input: DiagnosticInput) {
    if (!isId(input?.projectId) || !isRevision(input.editorRevision) ||
        [input.checkId, input.attemptId, input.runId].some(id => id !== undefined && !isId(id)) ||
        input.path !== undefined && (typeof input.path !== 'string' || !input.path.length || input.path.length > 2048)) {
      return fail('invalid_input', '需要项目 ID、编辑版本及有效的诊断范围');
    }
    const {projectId, editorRevision, checkId, attemptId, runId} = input;
    const queriedRun = runId === undefined ? undefined : debug.getRun(runId);
    if (queriedRun && !queriedRun.ok) return queriedRun;
    const run = queriedRun?.result;
    const records = diagnosticRecords({projectId, editorRevision, checkId, attemptId: attemptId ?? run?.attemptId});
    if (!records.ok) return records;
    const {check, build} = records.result;
    if (run && (run.projectId !== projectId || run.revision !== editorRevision || run.attemptId !== build?.attemptId)) {
      return fail('revision_conflict', '诊断记录不属于同一项目版本或构建');
    }
    const path = input.path?.replace(/^res:\/\//, '/');
    for (const item of [check, build]) {
      if (item && path) item.diagnostics.items = item.diagnostics.items.filter(diagnostic => diagnostic.location?.file === path);
    }
    const report = run?.exit?.report;
    const diagnostic = report?.diagnostic;
    const runtime = diagnostic && (!path || diagnostic.filename?.replace(/^res:\/\//, '/') === path) ? diagnostic : undefined;
    return ok({
      projectId, editorRevision, ...(path ? {path} : {}), check: check ?? null, build: build ?? null,
      run: run ? {runId: run.runId, attemptId: run.attemptId, state: run.state, evidence: run.exit?.evidence,
        observed: report?.sessionFacts !== undefined || diagnostic !== undefined,
        ...(runtime ? {diagnostic: runtime} : {})} : null,
    });
  }

  function getSummerDiagnostics() {
    const {projectId, editorRevision} = debug.getContext().result;
    if (projectId === null || editorRevision === null) return fail('not_ready', '当前编辑项目或版本尚未就绪');
    const records = diagnosticRecords({projectId, editorRevision});
    if (!records.ok) return records;
    const {check, build} = records.result;
    let run: SummerDiagnosticsData['run'] = null;
    if (build?.preview?.status === 'session-created') {
      const {runId} = build.preview;
      const found = debug.getRun(runId);
      if (!found.ok) {
        if (found.error.code !== 'not_found') return found;
        run = {availability: 'unavailable', runId, attemptId: build.attemptId};
      } else {
        const recorded = found.result;
        if (recorded.runId !== runId || recorded.projectId !== projectId || recorded.revision !== editorRevision ||
            recorded.attemptId !== build.attemptId || recorded.buildKey !== build.artifact?.buildKey ||
            recorded.artifact.artifactId !== build.artifact?.artifactId) {
          return fail('revision_conflict', '运行记录不属于本次诊断的构建');
        }
        run = projectDiagnosticRun(recorded);
      }
    }
    return ok<SummerDiagnosticsData>({
      projectId, editorRevision,
      check: check ? {checkId: check.checkId, status: check.status, sourceHash: check.sourceHash,
        diagnostics: check.diagnostics, error: check.error} : null,
      build: build ? {attemptId: build.attemptId, status: build.status, sourceHash: build.sourceHash,
        diagnostics: build.diagnostics, error: build.error, artifact: build.artifact, preview: build.preview} : null,
      run,
    });
  }

  async function getScriptErrors(path: string) {
    const {projectId, editorRevision, capabilities} = getProjectContext().result;
    if (projectId === null || editorRevision === null) return fail('not_ready', '当前编辑项目或版本尚未就绪');
    if (capabilities.check !== 'available') return fail(capabilities.check, '当前项目的执行环境不可用');
    if (!actions.hasScript(path)) return fail('not_found', '当前项目没有此脚本');
    const pending = actions.check(path);
    if (!pending) return fail('busy', '检查操作已达上限');
    const check = await pending;
    return ok<SummerScriptErrorsData>({...check, path: 'res:/' + path});
  }

  function waitFor(input: WaitInput, signal?: AbortSignal): Promise<ReturnType<typeof ok<WaitResult>> | ToolError> {
    const {attemptId, runId: initialRunId, until, timeoutMs = DEFAULT_TIMEOUT_MS} = input ?? {};
    if ((attemptId === undefined) === (initialRunId === undefined) ||
        (attemptId !== undefined ? !isId(attemptId) : !isId(initialRunId)) ||
        until !== 'running' && until !== 'exited' ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      return Promise.resolve(fail('invalid_input', '需要一个尝试或运行 ID、目标状态及 1 至 60000 毫秒的等待时间'));
    }
    if (signal !== undefined) {
      // The native getter checks the signal's brand across browser realms.
      try {
        if (readAborted.call(signal)) return Promise.resolve(fail('cancelled', '已取消等待'));
      } catch {
        return Promise.resolve(fail('invalid_input', '取消等待需要有效的 AbortSignal'));
      }
    }
    if (waitsDisposed) return Promise.resolve(fail('cancelled', '已取消等待'));
    if (waiting.size >= MAX_WAITERS) return Promise.resolve(fail('busy', '等待操作已达上限'));
    const releaseBuild = attemptId === undefined ? undefined : recorder.retainBuild(attemptId);
    if (attemptId !== undefined && !releaseBuild) return Promise.resolve(fail('not_found', '构建记录不可用'));
    let runId = initialRunId;
    let releaseRun = runId === undefined ? undefined : recorder.retainRun(runId);
    if (runId !== undefined && !releaseRun) return Promise.resolve(fail('not_found', '运行记录不可用'));
    return new Promise(resolve => {
      let completed = false;
      const finish = (value: ReturnType<typeof ok<WaitResult>> | ToolError) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        unsubscribe();
        waiting.delete(cancel);
        releaseRun?.();
        releaseBuild?.();
        if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', cancel);
        resolve(value);
      };
      const cancel = () => finish(fail('cancelled', '已取消等待'));
      function read(timedOut = false) {
        let build: DebugBuild | undefined;
        let run: DebugRun | undefined;
        if (attemptId !== undefined) {
          const result = debug.getBuild(attemptId);
          if (!result.ok) return finish(result);
          build = result.result;
          if (build.status === 'failed' || build.status === 'cancelled' ||
              build.preview?.status === 'skipped' || build.preview?.status === 'rejected') {
            return finish(ok({outcome: 'no_session', build}));
          }
          if (!runId && build.preview?.status === 'session-created') {
            runId = build.preview.runId;
            releaseRun = recorder.retainRun(runId);
          }
        }
        if (runId !== undefined) {
          const result = debug.getRun(runId);
          if (!result.ok) return finish(result);
          run = result.result;
          if (run.exit) return finish(ok({outcome: until === 'exited' ? 'reached' : 'exited_before_condition', build, run}));
          if (until === 'running' && run.state === 'running') return finish(ok({outcome: 'reached', build, run}));
        }
        if (timedOut) finish(ok({outcome: 'timeout', build, run}));
      }
      const unsubscribe = recorder.subscribe(read);
      const timer = setTimeout(() => read(true), timeoutMs);
      waiting.add(cancel);
      if (signal) EventTarget.prototype.addEventListener.call(signal, 'abort', cancel, {once: true});
      read();
    });
  }

  async function observeRuntime<Kind extends ObservationKind, Result>(kind: Kind, input: unknown, signal: AbortSignal | undefined,
    read: (runner: Observation, request: ObservationInput<Kind>) => Promise<ObservationResult<Result>>): Promise<ObservationResult<Result>> {
    const prepared = prepareRuntimeObservation(kind, input, signal);
    if (!prepared.ok) return prepared;
    const {runId, timeoutMs, query} = prepared.result;
    const run = debug.getRun(runId);
    if (!run.ok) return {ok: false, error: {code: 'not_found', message: run.error.message}};
    if (run.result.exit || run.result.state === 'stopping' || run.result.state === 'exited') {
      return {ok: false, error: {code: 'run_ended', message: '指定运行已结束或正在停止'}};
    }
    const runner = actions.observation?.();
    return runner ? read(runner, {runId, timeoutMs, ...query} as ObservationInput<Kind>) :
      {ok: false, error: {code: 'unsupported', message: '当前预览不支持运行时观察'}};
  }

  async function accessProperties<K extends PropertyKind>(kind: K, input: unknown, signal?: AbortSignal): Promise<PropertyResult<K>> {
    const prepared = prepareRuntimeProperties(kind, input, signal);
    if (!prepared.ok) return prepared;
    const {runId, timeoutMs, command} = prepared.result;
    const run = debug.getRun(runId);
    if (!run.ok) return runtimePropertiesError('not_found');
    if (run.result.exit || run.result.state === 'stopping' || run.result.state === 'exited') return runtimePropertiesError('run_ended');
    const runner = actions.runtimeProperties?.();
    if (!runner) return runtimePropertiesError('unsupported');
    const request = {runId, timeoutMs, ...command};
    // The kind discriminator belongs to the Worker command, not the public input.
    const {kind: _kind, ...value} = request;
    if (kind === 'describe') return runner.describeRuntimeProperties(value as DescribeInput, signal) as Promise<PropertyResult<K>>;
    if (kind === 'read') return runner.readRuntimeProperties(value as ReadInput, signal) as Promise<PropertyResult<K>>;
    return runner.writeRuntimeProperty(value as WriteInput, signal) as Promise<PropertyResult<K>>;
  }

  const methodBackend: SummerMethodBackend = {
    context() {
      const context = debug.getContext().result;
      return {projectId: context.projectId, editorRevision: context.editorRevision ?? 0,
        activeRunId: context.activeRunId, pendingAttemptId: context.latestBuildAttemptId};
    },
    run(runId) {
      const run = debug.getRun(runId);
      if (!run.ok) return run;
      return ok({...run.result, releaseId: run.result.release.releaseId,
        runtimeCall: actions.runtimeCall?.()?.runtimeCallState(runId) ?? {supported: false, ready: false}});
    },
    tree: (input, signal, deadline) => actions.runtimeCall?.()?.getRuntimeTree(input, signal, deadline) ??
      Promise.resolve(runtimeMethodError('unsupported')),
    describe: (input, signal, deadline) => actions.runtimeCall?.()?.describeRuntimeMethods(input, signal, deadline) ??
      Promise.resolve(runtimeMethodError('unsupported')),
    invoke: (input, signal, deadline) => actions.runtimeCall?.()?.callRuntimeMethod(input, signal, deadline) ??
      Promise.resolve(runtimeMethodError('unsupported')),
  };

  const summerCall = tool('summer_call', (input: unknown, signal?: AbortSignal, selected?: SelectedRuntimeMethod): Promise<FacadeReply> =>
    actions.summerCall?.(input, signal, selected) ??
    Promise.resolve({ok: false, error: {code: 'unsupported', message: 'Summer adapter is unavailable', retry: 'no', details: {godotai: {compatibility: {input: 'subset', semantics: 'partial', payload: 'godotai-typed-v1', summerNativeFixture: false}}}}}));

  const api = Object.freeze({
    schemaVersion: 1 as const,
    describe_runtime_methods: tool('describe_runtime_methods', (input: DescribeMethodsInput, signal?: AbortSignal) =>
      actions.runtimeCall?.()?.describeRuntimeMethods(input, signal) ?? Promise.resolve(runtimeMethodError('unsupported'))),
    call_runtime_method: tool('call_runtime_method', (input: CallMethodInput, signal?: AbortSignal) =>
      actions.runtimeCall?.()?.callRuntimeMethod(input, signal) ?? Promise.resolve(runtimeMethodError('unsupported'))),
    describe_runtime_properties: tool('describe_runtime_properties', (input: DescribeInput, signal?: AbortSignal) => accessProperties('describe', input, signal)),
    read_runtime_properties: tool('read_runtime_properties', (input: ReadInput, signal?: AbortSignal) => accessProperties('read', input, signal)),
    write_runtime_property: tool('write_runtime_property', (input: WriteInput, signal?: AbortSignal) => accessProperties('write', input, signal)),
    game_probe: tool('game_probe', async (input: GameProbeInput, signal?: AbortSignal): Promise<GameProbeResult> => {
      const prepared = prepareGameProbe(input, signal);
      if (!prepared.ok) return prepared;
      const {runId, query, timeoutMs} = prepared.result;
      const run = debug.getRun(runId);
      if (!run.ok) return gameProbeError('not_found');
      if (run.result.exit || run.result.state === 'stopping' || run.result.state === 'exited')
        return gameProbeError('run_ended');
      const runner = actions.gameProbe?.();
      return runner?.gameProbe({runId, ...query, timeoutMs}, signal) ?? gameProbeError('unsupported');
    }, result => {
      if (!result.ok || !result.result.image) return result;
      const {bytes, ...metadata} = result.result.image;
      return ok({...result.result, image: {...metadata, byteLength: bytes.byteLength}});
    }),
    summer_call: (input: unknown, signal?: AbortSignal) => summerCall(input, signal),
    run_game_input_script: tool('run_game_input_script', (input: InputScriptInput, signal?: AbortSignal) =>
      actions.inputScript?.()?.runGameInputScript(input, signal) ?? Promise.resolve(inputScriptFailure('unsupported'))),
    get_project_context: tool('get_project_context', getProjectContext),
    check: tool('check', async (input: ProjectInput) => {
      const rejected = admit(input, 'check');
      if (rejected) return rejected;
      const result = actions.check();
      return result ? ok(await result) : fail('busy', '检查操作已达上限');
    }),
    get_diagnostics: tool('get_diagnostics', diagnostics),
    play: tool('play', (input: ProjectInput) => {
      const rejected = admit(input, 'play');
      if (rejected) return rejected;
      const attemptId = actions.play();
      return attemptId ? ok({attemptId}) : fail('busy', '构建操作已达上限');
    }),
    wait_for_event: tool('wait_for_event', waitFor),
    stop: tool('stop', (input: {runId: string}): StopResult => {
      const result = debug.getRun(input?.runId);
      if (!result.ok) return result;
      if (result.result.exit) return ok({status: 'exited' as const, runId: input.runId, exit: result.result.exit});
      if (!actions.stopRun(input.runId)) return fail('not_found', '指定运行已不可用');
      const observed = debug.getRun(input.runId);
      return observed.ok && observed.result.exit ? ok({status: 'exited' as const, runId: input.runId, exit: observed.result.exit}) :
        ok({status: 'stopping' as const, runId: input.runId});
    }),
    get_build: tool('get_build', (input: {attemptId: string}) => debug.getBuild(input?.attemptId)),
    get_run: tool('get_run', (input: {runId: string}) => {
      const run = debug.getRun(input?.runId);
      if (!run.ok) return run;
      const {runId} = run.result;
      return ok({...run.result,
        interaction: actions.interaction?.()?.interactionState(runId) ?? {supported: false, ready: false},
        observation: actions.observation?.()?.observationState(runId) ?? {supported: false, ready: false},
        runtimeWrite: actions.runtimeWrite?.()?.runtimeWriteState(runId) ?? {supported: false, ready: false},
        runtimeProperties: actions.runtimeProperties?.()?.runtimePropertiesState(runId) ?? {supported: false, ready: false},
        runtimeCall: actions.runtimeCall?.()?.runtimeCallState(runId) ?? {supported: false, ready: false},
        gameProbe: actions.gameProbe?.()?.gameProbeState(runId) ?? {supported: false, ready: false},
        inputScript: actions.inputScript?.()?.inputScriptState(runId) ?? {supported: false, ready: false},
      });
    }),
    read_run_events: tool('read_run_events', (input: {runId: string} & ReadRunEventsOptions) => {
      const {runId, ...options} = input ?? {};
      return debug.readRunEvents(runId, options);
    }),
    screenshot: tool('screenshot', (input: ScreenshotInput, signal?: AbortSignal): Promise<InteractionResult<GameScreenshot>> =>
      actions.interaction?.()?.screenshot(input, signal) ?? Promise.resolve({ok: false, error: {code: 'unsupported', message: '当前预览不支持截图'}}), result => {
      if (!result.ok) return result;
      const {bytes, ...metadata} = result.result;
      return ok({...metadata, byteLength: bytes.byteLength});
    }),
    game_input: tool('game_input', (input: GameInput) =>
      actions.interaction?.()?.gameInput(input) ?? fail('unsupported', '当前预览不支持自动输入')),
    wait_for_input: tool('wait_for_input', (input: WaitForInput, signal?: AbortSignal) =>
      actions.interaction?.()?.waitForInput(input, signal) ?? Promise.resolve(fail('unsupported', '当前预览不支持输入回执'))),
    get_runtime_tree: tool('get_runtime_tree', (input: RuntimeTreeInput, signal?: AbortSignal) =>
      observeRuntime('tree', input, signal, (runner, request) => runner.getRuntimeTree(request, signal))),
    inspect_runtime_node: tool('inspect_runtime_node', (input: RuntimeNodeInput, signal?: AbortSignal) =>
      observeRuntime('node', input, signal, (runner, request) => runner.inspectRuntimeNode(request, signal))),
    runtime_set: tool('runtime_set', async (input: RuntimeSetInput, signal?: AbortSignal): Promise<RuntimeSetResult> => {
      const prepared = prepareRuntimeSet(input, signal);
      if (!prepared.ok) return prepared;
      const {runId, timeoutMs, command} = prepared.result;
      const run = debug.getRun(runId);
      if (!run.ok) return runtimeWriteError('not_found');
      if (run.result.exit || run.result.state === 'stopping' || run.result.state === 'exited') return runtimeWriteError('run_ended');
      const runner = actions.runtimeWrite?.();
      return runner ? runner.setRuntimeProperty({runId, timeoutMs, ...command}, signal) : runtimeWriteError('unsupported');
    }, undefined, input => {
      const prepared = prepareRuntimeSet(input);
      if (!prepared.ok) return {omitted: true};
      const {runId, timeoutMs, command} = prepared.result;
      return {runId, timeoutMs, ...command};
    }),
  });

  return {
    api, methodBackend, summerCall, getSummerDiagnostics, getScriptErrors,
    subscribe(observer: (call: PlaygroundApiCall) => void) {
      observers.add(observer);
      return () => { observers.delete(observer); };
    },
    recentLifecycleEvents, waitLifecycleEvents, cancelWaits,
    disposeWaits() {
      waitsDisposed = true;
      cancelWaits();
    },
  };
}

export type PlaygroundApi = ReturnType<typeof createPlaygroundApi>['api'];

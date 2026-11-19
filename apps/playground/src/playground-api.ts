import type {
  createDebugRecorder, DebugBuild, DebugCheck, DebugRun, ReadRunEventsOptions,
} from './debug-api';

type Recorder = ReturnType<typeof createDebugRecorder>;
type ErrorCode = 'invalid_input' | 'not_found' | 'invalid_cursor' | 'revision_conflict' |
  'not_ready' | 'unsupported' | 'busy' | 'cancelled';
type ToolError = {ok: false; error: {code: ErrorCode; message: string}};
type ProjectInput = {projectId: string; expectedEditorRevision: number};
type DiagnosticInput = {projectId: string; editorRevision: number; checkId?: string; attemptId?: string; runId?: string; path?: string};
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

interface Actions {
  supportsProject(): boolean;
  check(): Promise<DebugCheck> | undefined;
  play(): string | undefined;
  stopRun(runId: string): Promise<unknown> | undefined;
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

export function createPlaygroundApi(recorder: Recorder, actions: Actions) {
  const debug = recorder.api;
  const observers = new Set<(call: PlaygroundApiCall) => void>();
  const waiting = new Set<() => void>();

  function publish(name: string, input: unknown, result: unknown) {
    for (const observer of observers) {
      try { observer({name, input, result}); } catch { /* Diagnostics cannot change tool execution. */ }
    }
  }

  function tool<Args extends unknown[], Result>(name: string, execute: (...args: Args) => Result) {
    return (...args: Args): Result => {
      const result = execute(...args);
      if (observers.size) {
        // Snapshot parameters at submission. Invalid or excessive inputs need no full UI copy.
        let input: unknown;
        try {
          const json = JSON.stringify(args[0]);
          input = json === undefined ? {} : json.length <= 4096 ? JSON.parse(json) : {omitted: true};
        } catch { input = {omitted: true}; }
        if (result instanceof Promise) void result.then(value => publish(name, input, value), () => {});
        else publish(name, input, result);
      }
      return result;
    };
  }

  function getProjectContext() {
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
    const queriedBuildId = attemptId ?? run?.attemptId;
    const queriedBuild = queriedBuildId === undefined ? undefined : debug.getBuild(queriedBuildId);
    if (queriedBuild && !queriedBuild.ok) return queriedBuild;
    const build = queriedBuild?.result ?? recorder.getBuildForRevision(projectId, editorRevision);
    const check = checkId === undefined ? recorder.getCheckForRevision(projectId, editorRevision) : recorder.getCheck(checkId);
    if (checkId !== undefined && !check) return fail('not_found', '检查记录不可用');
    if ([check, build].some(item => item && (item.projectId !== projectId || item.editorRevision !== editorRevision)) ||
        run && (run.projectId !== projectId || run.revision !== editorRevision || run.attemptId !== build?.attemptId)) {
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

  const api = Object.freeze({
    schemaVersion: 1 as const,
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
    stop: tool('stop', (input: {runId: string}) => {
      const result = debug.getRun(input?.runId);
      if (!result.ok) return result;
      if (result.result.exit) return ok({status: 'exited' as const, runId: input.runId, exit: result.result.exit});
      if (!actions.stopRun(input.runId)) return fail('not_found', '指定运行已不可用');
      const observed = debug.getRun(input.runId);
      return observed.ok && observed.result.exit ? ok({status: 'exited' as const, runId: input.runId, exit: observed.result.exit}) :
        ok({status: 'stopping' as const, runId: input.runId});
    }),
    get_build: tool('get_build', (input: {attemptId: string}) => debug.getBuild(input?.attemptId)),
    get_run: tool('get_run', (input: {runId: string}) => debug.getRun(input?.runId)),
    read_run_events: tool('read_run_events', (input: {runId: string} & ReadRunEventsOptions) => {
      const {runId, ...options} = input ?? {};
      return debug.readRunEvents(runId, options);
    }),
  });

  return {
    api,
    subscribe(observer: (call: PlaygroundApiCall) => void) {
      observers.add(observer);
      return () => { observers.delete(observer); };
    },
    cancelWaits() {
      for (const cancel of waiting) cancel();
    },
  };
}

export type PlaygroundApi = ReturnType<typeof createPlaygroundApi>['api'];

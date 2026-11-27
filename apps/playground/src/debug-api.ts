import type {PreviewDiagnostic, RunnerState} from '@godot-js/engine/browser/protocol';
import {sameWorkerRun, type WorkerRunIdentity} from '@godot-js/engine/browser/dedicated/worker-protocol';
import type {WorkerRunnerEvent, WorkerRunnerExit} from '@godot-js/engine/browser/dedicated/worker-runner';
import {createLifecycleLog, type LifecycleExit} from './lifecycle-events.ts';

export interface DebugDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message?: string;
  code?: string | number;
  location?: {file?: string; line?: number; column?: number};
  omitted?: true;
}

export interface DebugDiagnostics {
  observed: boolean;
  counts?: Record<DebugDiagnostic['severity'], number>;
  items: DebugDiagnostic[];
  omittedCount: number;
}

export interface DebugFailure {
  stage: 'release' | 'preview-initialize' | 'check-request' | 'check' | 'compile-request' | 'compile' | 'preview-prepare';
  diagnostic: DebugDiagnostic;
}

export interface DebugRelease {
  releaseId: string;
  engineProfile: string;
  descriptorSha256: string;
  candidateId?: string;
  engineId?: string;
  extensionId?: string;
  artifactReceiptVersion?: 2;
  artifactSetAbi?: 1;
}

export interface DebugPreviewConfiguration {
  executionBackend: 'worker';
  presentationBackend: 'direct' | 'bitmap';
}

export type DebugAvailability<T> =
  | {status: 'loading' | 'unsupported'; reason?: string}
  | {status: 'available'; value: T}
  | {status: 'failed'; error: DebugFailure};

export interface DebugContext {
  projectId: string | null;
  editorRevision: number | null;
  release: DebugAvailability<DebugRelease>;
  preview: DebugAvailability<DebugPreviewConfiguration>;
  latestBuildAttemptId: string | null;
  activeRunId: string | null;
  lastExitedRunId: string | null;
}

export interface DebugArtifact {
  variant: 'single-pack' | 'pack-set';
  buildKey: string;
  artifactId: string;
}

export type DebugPreview =
  | {status: 'not-requested' | 'preparing' | 'skipped'}
  | {status: 'rejected'; error: DebugFailure}
  | {status: 'session-created'; runId: string};

export interface DebugBuild {
  attemptId: string;
  projectId: string;
  editorRevision: number;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  sourceHash?: string;
  environmentFacts?: Record<string, unknown>;
  compilerIdentity?: Record<string, unknown>;
  diagnostics: DebugDiagnostics;
  error?: DebugFailure;
  artifact?: DebugArtifact;
  preview?: DebugPreview;
}

export interface DebugCheck {
  checkId: string;
  projectId: string;
  editorRevision: number;
  scope: 'typecheck';
  status: 'completed' | 'failed';
  sourceHash?: string;
  compilerIdentity?: Record<string, unknown>;
  diagnostics: DebugDiagnostics;
  error?: DebugFailure;
}

export interface DebugExit {
  evidence: 'host-report' | 'editor-local';
  report: WorkerRunnerExit;
}

export interface DebugRun extends WorkerRunIdentity {
  projectId: string;
  attemptId: string;
  artifact: DebugArtifact;
  release: DebugRelease;
  configuration: DebugPreviewConfiguration;
  state: RunnerState;
  exit?: DebugExit;
}

const EVENT_KINDS = ['state', 'log', 'project', 'exit'] as const;
const LOG_LEVELS = ['log', 'warn', 'error'] as const;
type DebugEventKind = typeof EVENT_KINDS[number];
type DebugLogLevel = typeof LOG_LEVELS[number];

export type DebugEvent =
  | {type: 'state'; state: RunnerState}
  | {type: 'log'; level: DebugLogLevel; text: string; untrusted: true; source: 'preview-worker'}
  | {type: 'project'; data: Record<string, unknown>; source: 'project'}
  | {type: 'exit'; exit: DebugExit}
  | {type: DebugEventKind; omitted: true; level?: DebugLogLevel; source?: 'preview-worker' | 'project'};

export interface DebugEventPage {
  items: {seq: number; event: DebugEvent}[];
  nextCursor: string;
  oldestAvailableSeq: number | null;
  hasMore: boolean;
  gap?: {fromSeq: number; toSeq: number};
}

export interface ReadRunEventsOptions {
  after?: string;
  limit?: number;
  kinds?: readonly DebugEventKind[];
  levels?: readonly DebugLogLevel[];
}

type DebugQueryError = {code: 'invalid_input' | 'not_found' | 'invalid_cursor'; message: string};
export type DebugResult<T> = {ok: true; result: T} | {ok: false; error: DebugQueryError};

export interface DebugApi {
  readonly schemaVersion: 1;
  getContext(): {ok: true; result: DebugContext};
  getBuild(attemptId: string): DebugResult<DebugBuild>;
  getRun(runId: string): DebugResult<DebugRun>;
  readRunEvents(runId: string, options?: ReadRunEventsOptions): DebugResult<DebugEventPage>;
}

type PageContext = Pick<DebugContext, 'projectId' | 'editorRevision' | 'release' | 'preview'>;
type BuildRecord = {order: number; view: DebugBuild; references: number};
type CheckRequest = Pick<DebugCheck, 'checkId' | 'projectId' | 'editorRevision'> & {order: number};
type PendingPreview = {
  generation: WorkerRunIdentity['generation'];
  release: DebugRelease;
  configuration: DebugPreviewConfiguration;
  build: BuildRecord;
};
type EventRecord = {seq: number; event: DebugEvent; bytes: number};
type RunRecord = {
  build: BuildRecord;
  view: DebugRun;
  events: EventRecord[];
  seq: number;
  eventBytes: number;
  startedObserved: boolean;
};

const MAX_BUILDS = 16;
const MAX_EXITED_RUNS = 2;
const MAX_DIAGNOSTICS = 100;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_FAILURE_BYTES = 4 * 1024;
// Leave room for the diagnostic counts and the one build or preview failure.
const MAX_DIAGNOSTIC_LIST_BYTES = MAX_DIAGNOSTIC_BYTES - MAX_FAILURE_BYTES - 256;
const MAX_EVENTS = 500;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_ERROR_TEXT = 4096;
const encoder = new TextEncoder();
const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const ok = <T>(result: T) => ({ok: true as const, result: structuredClone(result)});
const fail = (code: DebugQueryError['code'], message: string) => ({ok: false as const, error: {code, message}});
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function diagnosticCode(value: unknown): string | number | undefined {
  return isId(value) || typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function boundedFailure(failure: DebugFailure): DebugFailure {
  const {severity, message, omitted} = failure.diagnostic;
  const code = diagnosticCode(failure.diagnostic.code);
  const location = failure.diagnostic.location;
  const diagnostic: DebugDiagnostic = {severity};
  if (typeof message === 'string') diagnostic.message = message.slice(0, MAX_ERROR_TEXT);
  if (code !== undefined) diagnostic.code = code;
  if (location) {
    const normalized = diagnosticLocation(location);
    if (Object.keys(normalized).length) diagnostic.location = normalized;
  }
  if (omitted || message && message.length > MAX_ERROR_TEXT) diagnostic.omitted = true;
  const result = {stage: failure.stage, diagnostic};
  if (bytesOf(result) > MAX_FAILURE_BYTES) {
    delete diagnostic.message;
    diagnostic.omitted = true;
    if (bytesOf(result) > MAX_FAILURE_BYTES) delete diagnostic.location?.file;
    // JSON can use up to six bytes per UTF-16 code unit.
    const remaining = MAX_FAILURE_BYTES - bytesOf(result) - bytesOf({message: ''});
    if (message && remaining >= 6) diagnostic.message = message.slice(0, Math.floor(remaining / 6));
  }
  return result;
}

export function debugFailure(stage: DebugFailure['stage'], error: unknown, reportedCode?: unknown): DebugFailure {
  const details = record(error);
  const message = typeof error === 'string' ? error : typeof details?.message === 'string' ? details.message : '操作失败';
  // Plain engine errors use a leading E_* code, and older Worker replies add "Error: ".
  const code = diagnosticCode(reportedCode) ?? diagnosticCode(details?.code) ??
    /^(?:Error: )?(E_[A-Z][A-Z0-9_]{0,253})(?=:|$)/.exec(message)?.[1];
  return boundedFailure({stage, diagnostic: {severity: 'error', message, code}});
}

function diagnosticLocation(item: Record<string, unknown>): NonNullable<DebugDiagnostic['location']> {
  const location: NonNullable<DebugDiagnostic['location']> = {};
  if (typeof item.file === 'string' && item.file.length > 0 && item.file.length <= 2048) location.file = item.file;
  if (typeof item.line === 'number' && Number.isSafeInteger(item.line) && item.line > 0) location.line = item.line;
  if (typeof item.column === 'number' && Number.isSafeInteger(item.column) && item.column > 0) location.column = item.column;
  return location;
}

const unknownDiagnostics = (): DebugDiagnostics => ({observed: false, items: [], omittedCount: 0});

function buildDiagnostics(value: unknown, path?: string): DebugDiagnostics {
  if (!Array.isArray(value)) return unknownDiagnostics();
  const bySeverity: Record<DebugDiagnostic['severity'], Record<string, unknown>[]> = {
    error: [], warning: [], info: [],
  };
  for (const raw of value) {
    const item = record(raw);
    const severity = item?.category;
    if (!item || typeof item.message !== 'string' || severity !== 'error' && severity !== 'warning' && severity !== 'info') {
      return unknownDiagnostics();
    }
    if (path !== undefined && item.file !== path) continue;
    bySeverity[severity].push(item);
  }

  const items: DebugDiagnostic[] = [];
  let bytes = 2; // JSON array delimiters
  for (const severity of ['error', 'warning', 'info'] as const) {
    for (const item of bySeverity[severity]) {
      if (items.length >= MAX_DIAGNOSTICS) break;
      const location = diagnosticLocation(item);
      const code = item.code === 0 && !item.file && item.line === 0 && item.column === 0 ? undefined : diagnosticCode(item.code);
      const diagnostic: DebugDiagnostic = {
        severity,
        ...(code === undefined ? {} : {code}),
        ...(Object.keys(location).length ? {location} : {}),
      };
      const message = item.message as string;
      if (message.length <= MAX_DIAGNOSTIC_LIST_BYTES) diagnostic.message = message;
      if (diagnostic.message === undefined || bytesOf(diagnostic) + 2 > MAX_DIAGNOSTIC_LIST_BYTES) {
        delete diagnostic.message;
        diagnostic.omitted = true;
      }
      const cost = bytesOf(diagnostic) + (items.length > 0 ? 1 : 0);
      if (bytes + cost > MAX_DIAGNOSTIC_LIST_BYTES) continue;
      items.push(diagnostic);
      bytes += cost;
    }
  }
  const counts = {error: bySeverity.error.length, warning: bySeverity.warning.length, info: bySeverity.info.length};
  return {observed: true, counts, items, omittedCount: counts.error + counts.warning + counts.info - items.length};
}

function releaseSnapshot(value: Record<string, unknown>): DebugRelease | undefined {
  const {releaseId, engineProfile, descriptorSha256, candidateId, engineId, extensionId, artifactReceiptVersion, artifactSetAbi} = value;
  if (!isId(releaseId) || !isId(engineProfile) || !digest(descriptorSha256)) return;
  return {
    releaseId, engineProfile, descriptorSha256,
    ...(digest(candidateId) ? {candidateId} : {}),
    ...(digest(engineId) ? {engineId} : {}),
    ...(digest(extensionId) ? {extensionId} : {}),
    ...(artifactReceiptVersion === 2 ? {artifactReceiptVersion: 2} : {}),
    ...(artifactSetAbi === 1 ? {artifactSetAbi: 1} : {}),
  };
}

function smallFields(value: unknown, fields: readonly string[]): Record<string, string | number | boolean> {
  const input = record(value);
  const entries: [string, string | number | boolean][] = [];
  for (const key of fields) {
    const item = input?.[key];
    if (typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) ||
        typeof item === 'string' && item.length <= 256) entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

function environmentSnapshot(value: unknown): Record<string, unknown> | undefined {
  const input = record(value);
  if (!input) return;
  const release = releaseSnapshot(record(input.release) ?? {});
  if (!release) return;
  const resources = record(input.resources);
  const target = record(resources?.target);
  const features = Object.keys(record(target?.features) ?? {}).filter(key => key.length <= 256).slice(0, 32);
  return {
    release,
    ...smallFields(input, ['naming', 'requiredExtensionId', 'bindingVersion', 'compilerPolicy', 'typescriptVersion']),
    selection: smallFields(input.selection, ['kind', 'mode']),
    api: smallFields(input.api, ['status', 'reason']),
    resources: {
      ...smallFields(resources, ['status', 'reason']),
      ...(target ? {target: {...smallFields(target, ['resourceAbi']), features: smallFields(target.features, features)}} : {}),
    },
    baseRuntimeModules: Array.isArray(input.baseRuntimeModules) ? input.baseRuntimeModules.filter(isId).slice(0, 64) : [],
    assetReadLimits: smallFields(input.assetReadLimits, ['maxStoredBytes', 'maxDecodedBytes']),
  };
}

function compilerSnapshot(value: unknown): Record<string, unknown> | undefined {
  const input = record(value);
  if (!input) return;
  const moduleKeys = Object.keys(record(input.runtimeModules) ?? {}).filter(key => key.length <= 256).slice(0, 64);
  return {
    ...smallFields(input, ['policy', 'typescript', 'declarations', 'moduleDeclarations', 'vendor']),
    target: smallFields(input.target, ['engineId', 'extensionId', 'engineReleaseId', 'engineProfile', 'naming',
      'bindingVersion', 'artifactSetAbi', 'compatibilityAdapter']),
    runtimeModules: smallFields(input.runtimeModules, moduleKeys),
  };
}

function artifactFromResponse(response: Record<string, unknown>): DebugArtifact | undefined {
  const manifest = record(response.manifest);
  const {variant} = response;
  if (!manifest || manifest.variant !== variant || !digest(manifest.buildKey) || !digest(manifest.artifactId)) return;
  if (variant === 'single-pack' && response.pack instanceof Uint8Array && response.pack.byteLength > 0 ||
      variant === 'pack-set' && record(response.artifactSet)) {
    return {variant, buildKey: manifest.buildKey, artifactId: manifest.artifactId};
  }
}

function runIdentity(event: WorkerRunIdentity): WorkerRunIdentity {
  const {runId, revision, buildKey, generation, documentId, workerId, runConfigurationHash} = event;
  return {runId, revision, buildKey, generation, documentId, workerId, runConfigurationHash};
}

function lifecycleData({view, build}: RunRecord) {
  return {
    projectId: view.projectId, editorRevision: build.view.editorRevision,
    attemptId: view.attemptId, run: runIdentity(view), artifactId: view.artifact.artifactId,
    releaseId: view.release.releaseId, ...(build.view.sourceHash ? {sourceHash: build.view.sourceHash} : {}),
  };
}

function runtimeDiagnostic(value: PreviewDiagnostic): PreviewDiagnostic {
  const {source, message, name, stack, filename, line, column} = value;
  return {
    source, message,
    ...(name === undefined ? {} : {name}),
    ...(stack === undefined ? {} : {stack}),
    ...(filename === undefined ? {} : {filename}),
    ...(line === undefined ? {} : {line}),
    ...(column === undefined ? {} : {column}),
  };
}

function exitSnapshot(report: WorkerRunnerExit): DebugExit {
  const base = {
    ...runIdentity(report),
    ...(report.detail === undefined ? {} : {detail: report.detail}),
    ...(report.diagnostic === undefined ? {} : {diagnostic: runtimeDiagnostic(report.diagnostic)}),
  };
  if (report.engineOutcome === undefined) {
    return {evidence: 'editor-local', report: {...base, reason: report.reason}};
  }
  return {
    evidence: 'host-report',
    report: {
      ...base,
      reason: report.reason,
      ...(report.code === undefined ? {} : {code: report.code}),
      engineOutcome: structuredClone(report.engineOutcome),
      hostCleanup: structuredClone(report.hostCleanup),
      sessionFacts: structuredClone(report.sessionFacts),
    },
  };
}

function appendEvent(run: RunRecord, event: DebugEvent) {
  const seq = ++run.seq;
  let bytes = bytesOf({seq, event});
  if (bytes > MAX_EVENT_BYTES) {
    event = {
      type: event.type, omitted: true,
      ...('level' in event ? {level: event.level} : {}),
      ...('source' in event ? {source: event.source} : {}),
    };
    bytes = bytesOf({seq, event});
  } else if (event.type === 'project' && 'data' in event) {
    event = {...event, data: structuredClone(event.data)};
  }
  run.events.push({seq, event, bytes});
  run.eventBytes += bytes;
  while (run.events.length > MAX_EVENTS || run.eventBytes > MAX_EVENT_BYTES) {
    run.eventBytes -= run.events.shift()!.bytes;
  }
}

function availability<T>(input: DebugAvailability<T>): DebugAvailability<T> {
  if (input.status === 'failed') return {status: 'failed', error: boundedFailure(input.error)};
  if (input.status === 'available') return {status: 'available', value: structuredClone(input.value)};
  return {status: input.status, ...(input.reason === undefined ? {} : {reason: input.reason.slice(0, MAX_ERROR_TEXT)})};
}

export function createDebugRecorder() {
  const pageId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const lifecycle = createLifecycleLog(pageId);
  const context: PageContext = {projectId: null, editorRevision: null, release: {status: 'loading'}, preview: {status: 'loading'}};
  const builds: BuildRecord[] = [];
  const retainedBuilds = new Set<BuildRecord>();
  const checks: {order: number; view: DebugCheck}[] = [];
  const previews = new Map<WorkerRunIdentity['generation'], PendingPreview>();
  const exitedRuns: RunRecord[] = [];
  const retainedRuns = new Map<RunRecord, number>();
  const listeners = new Set<() => void>();
  let activeRun: RunRecord | undefined;
  let order = 0;
  let checkOrder = 0;
  let notifying = false;

  function notify() {
    if (notifying) return;
    notifying = true;
    queueMicrotask(() => {
      notifying = false;
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* A debug observer cannot change product execution. */ }
      }
    });
  }

  const pinnedBuilds = () => [...(activeRun ? [activeRun.build] : []), ...exitedRuns.map(run => run.build),
    ...Array.from(retainedRuns.keys(), run => run.build)];
  const findBuild = (attemptId: string) =>
    [...builds, ...retainedBuilds, ...pinnedBuilds()].find(build => build.view.attemptId === attemptId);
  const findRun = (runId: string) =>
    activeRun?.view.runId === runId ? activeRun : [...exitedRuns, ...retainedRuns.keys()].find(run => run.view.runId === runId);
  function latestBuild(projectId: string | null, editorRevision?: number) {
    return [...builds, ...retainedBuilds, ...pinnedBuilds()].reduce<BuildRecord | undefined>((current, build) =>
      build.view.projectId === projectId && (editorRevision === undefined || editorRevision === build.view.editorRevision) &&
      (!current || current.order < build.order) ? build : current, undefined)?.view;
  }

  const api: DebugApi = {
    schemaVersion: 1,
    getContext() {
      const latest = latestBuild(context.projectId);
      return ok({...context, latestBuildAttemptId: latest?.attemptId ?? null, activeRunId: activeRun?.view.runId ?? null,
        lastExitedRunId: exitedRuns.at(-1)?.view.runId ?? null});
    },
    getBuild(attemptId) {
      if (!isId(attemptId)) return fail('invalid_input', '需要构建尝试 ID');
      const build = findBuild(attemptId);
      return build ? ok(build.view) : fail('not_found', '构建记录不可用');
    },
    getRun(runId) {
      if (!isId(runId)) return fail('invalid_input', '需要运行 ID');
      const run = findRun(runId);
      return run ? ok(run.view) : fail('not_found', '运行记录不可用');
    },
    readRunEvents(runId, options = {}) {
      const {after, limit = 50, kinds, levels} = options ?? {};
      if (!isId(runId) || !record(options) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
          kinds !== undefined && (!Array.isArray(kinds) || ![...kinds].every(kind => EVENT_KINDS.includes(kind))) ||
          levels !== undefined && (!Array.isArray(levels) || ![...levels].every(level => LOG_LEVELS.includes(level)))) {
        return fail('invalid_input', '运行事件参数无效');
      }
      const run = findRun(runId);
      if (!run) return fail('not_found', '运行记录不可用');
      const prefix = pageId + ':' + runId + ':';
      const highWater = run.seq;
      let scanned = 0;
      if (after !== undefined) {
        if (typeof after !== 'string' || !after.startsWith(prefix)) return fail('invalid_cursor', '游标不属于此运行');
        const cursor = after.slice(prefix.length);
        if (!/^(0|[1-9]\d{0,15})$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) > highWater) {
          return fail('invalid_cursor', '运行游标无效');
        }
        scanned = Number(cursor);
      }
      const oldestAvailableSeq = run.events[0]?.seq ?? null;
      const firstAvailable = oldestAvailableSeq ?? highWater + 1;
      const gap = scanned < firstAvailable - 1 ? {fromSeq: scanned + 1, toSeq: firstAvailable - 1} : undefined;
      scanned = Math.max(scanned, firstAvailable - 1);
      const items: DebugEventPage['items'] = [];
      for (const {seq, event} of run.events) {
        if (seq <= scanned) continue;
        scanned = seq;
        if (kinds && !kinds.includes(event.type) || levels && event.type === 'log' && (!event.level || !levels.includes(event.level))) continue;
        items.push({seq, event});
        if (items.length === limit) break;
      }
      return ok({items, nextCursor: prefix + scanned, oldestAvailableSeq, hasMore: scanned < highWater, ...(gap ? {gap} : {})});
    },
  };

  return {
    api: Object.freeze(api),
    lifecycle,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getBuildForRevision(projectId: string, editorRevision: number) {
      return structuredClone(latestBuild(projectId, editorRevision));
    },
    getCheck(checkId: string) {
      return structuredClone(checks.find(check => check.view.checkId === checkId)?.view);
    },
    getCheckForRevision(projectId: string, editorRevision: number) {
      let latest: (typeof checks)[number] | undefined;
      for (const check of checks) {
        if (check.view.projectId === projectId && check.view.editorRevision === editorRevision &&
            (!latest || check.order > latest.order)) latest = check;
      }
      return structuredClone(latest?.view);
    },
    startCheck(projectId: string, editorRevision: number): CheckRequest {
      return {order: ++checkOrder, checkId: 'check-' + checkOrder, projectId, editorRevision};
    },
    finishCheck({order, ...request}: CheckRequest, response: unknown, requestError?: DebugFailure, path?: string): DebugCheck {
      const result = record(response);
      const diagnostics = result?.error === undefined ? buildDiagnostics(result?.diagnostics) : unknownDiagnostics();
      const error = requestError ?? (diagnostics.observed ? undefined :
        debugFailure('check', result?.error ?? '编译器未返回类型检查结果', result?.errorCode));
      const compilerIdentity = compilerSnapshot(result?.compilerIdentity);
      const view: DebugCheck = {
        ...request, scope: 'typecheck', status: error ? 'failed' : 'completed',
        ...(digest(result?.sourceHash) ? {sourceHash: result.sourceHash} : {}),
        ...(compilerIdentity ? {compilerIdentity} : {}),
        diagnostics, ...(error ? {error} : {}),
      };
      // Retain the project check and scope the reply from the uncapped compiler diagnostics.
      const scoped = path && view.status === 'completed'
        ? {...view, diagnostics: buildDiagnostics(result?.diagnostics, path)}
        : view;
      checks.push({order, view});
      if (checks.length > MAX_BUILDS) checks.shift();
      notify();
      return structuredClone(scoped);
    },
    setContext(patch: Partial<PageContext>) {
      if (patch.projectId !== undefined) context.projectId = patch.projectId;
      if (patch.editorRevision !== undefined) context.editorRevision = patch.editorRevision;
      if (patch.release) context.release = availability(patch.release);
      if (patch.preview) context.preview = availability(patch.preview);
      notify();
    },
    startBuild(projectId: string, editorRevision: number): string {
      const attemptId = 'build-' + ++order;
      builds.push({order, references: 0, view: {attemptId, projectId, editorRevision, status: 'pending', diagnostics: unknownDiagnostics(),
        ...(context.preview.status === 'unsupported' ? {} : {preview: {status: 'not-requested'}})}});
      if (builds.length > MAX_BUILDS) builds.shift();
      notify();
      return attemptId;
    },
    retainBuild(attemptId: string) {
      const build = findBuild(attemptId);
      if (!build) return undefined;
      build.references++;
      retainedBuilds.add(build);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--build.references === 0) retainedBuilds.delete(build);
      };
    },
    retainRun(runId: string) {
      const run = findRun(runId);
      if (!run) return undefined;
      retainedRuns.set(run, (retainedRuns.get(run) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (retainedRuns.get(run) ?? 1) - 1;
        if (remaining) retainedRuns.set(run, remaining);
        else retainedRuns.delete(run);
      };
    },
    recordCompileResponse(attemptId: string, response: unknown) {
      const build = findBuild(attemptId)?.view;
      if (!build || build.status !== 'pending') return;
      const result = record(response) ?? {};
      if (digest(result.sourceHash)) build.sourceHash = result.sourceHash;
      const environmentFacts = environmentSnapshot(result.environmentFacts);
      const compilerIdentity = compilerSnapshot(result.compilerIdentity);
      if (environmentFacts) build.environmentFacts = environmentFacts;
      if (compilerIdentity) build.compilerIdentity = compilerIdentity;
      if (result.cancelled === true) {
        build.status = 'cancelled';
      } else {
        build.diagnostics = buildDiagnostics(result.diagnostics);
        const artifact = artifactFromResponse(result);
        if (artifact && result.error === undefined && !build.diagnostics.counts?.error) {
          build.status = 'succeeded';
          build.artifact = artifact;
        } else {
          build.status = 'failed';
          if (typeof result.error === 'string' || !build.diagnostics.counts?.error) {
            build.error = debugFailure('compile', result.error ?? '构建响应缺少有效产物', result.errorCode);
          }
        }
      }
      notify();
    },
    failBuild(attemptId: string, error: DebugFailure) {
      const build = findBuild(attemptId)?.view;
      if (!build || build.status !== 'pending') return;
      build.status = 'failed';
      build.error = boundedFailure(error);
      notify();
    },
    beginPreview(attemptId: string) {
      const build = findBuild(attemptId)?.view;
      if (build?.status !== 'succeeded' || build.preview?.status !== 'not-requested') return;
      build.preview = {status: 'preparing'};
      notify();
    },
    skipPreview(attemptId: string) {
      const build = findBuild(attemptId)?.view;
      if (build?.status !== 'succeeded' || build.preview?.status !== 'preparing' && build.preview?.status !== 'not-requested') return;
      build.preview = {status: 'skipped'};
      notify();
    },
    rejectPreview(attemptId: string, error: DebugFailure) {
      const build = findBuild(attemptId)?.view;
      if (build?.status !== 'succeeded' || build.preview?.status !== 'preparing') return;
      build.preview = {status: 'rejected', error: boundedFailure(error)};
      notify();
    },
    registerPreview(attemptId: string, metadata: Omit<PendingPreview, 'build'>): () => void {
      const build = findBuild(attemptId);
      if (!build?.view.artifact || build.view.preview?.status !== 'preparing' || previews.has(metadata.generation)) return () => {};
      const pending = {...structuredClone(metadata), build};
      previews.set(pending.generation, pending);
      return () => {
        if (previews.get(pending.generation) === pending) previews.delete(pending.generation);
      };
    },
    recordRunEvent(event: WorkerRunnerEvent) {
      const identity = event.type === 'exit' ? event.report : event;
      let run = activeRun;
      if (event.type === 'state' && event.state === 'loading-frame') {
        const pending = previews.get(identity.generation);
        const build = pending?.build.view;
        if (run || findRun(identity.runId) || !pending || !build?.artifact || build.preview?.status !== 'preparing' ||
            identity.revision !== build.editorRevision || identity.buildKey !== build.artifact.buildKey) return;
        const view: DebugRun = {
          ...runIdentity(identity),
          projectId: build.projectId, attemptId: build.attemptId, artifact: build.artifact,
          release: pending.release, configuration: pending.configuration, state: 'loading-frame',
        };
        run = activeRun = {build: pending.build, view, seq: 0, eventBytes: 0, events: [], startedObserved: false};
        previews.delete(identity.generation);
        build.preview = {status: 'session-created', runId: identity.runId};
      }
      if (!run || !sameWorkerRun(run.view, identity)) return;
      switch (event.type) {
        case 'state':
          run.view.state = event.state;
          appendEvent(run, {type: 'state', state: event.state});
          if (event.state === 'running' && !run.startedObserved) {
            run.startedObserved = true;
            lifecycle.append({kind: 'play.started', data: lifecycleData(run)});
          }
          break;
        case 'log':
          appendEvent(run, {type: 'log', level: event.level, text: event.text, untrusted: true, source: 'preview-worker'});
          break;
        case 'project':
          appendEvent(run, {type: 'project', data: event.data, source: 'project'});
          break;
        case 'exit': {
          const exit = exitSnapshot(event.report);
          run.view.state = 'exited';
          run.view.exit = exit;
          appendEvent(run, {type: 'exit', exit});
          const summary: LifecycleExit = {evidence: exit.evidence, reason: exit.report.reason};
          if (exit.report.sessionFacts) {
            const {failure, ...facts} = exit.report.sessionFacts;
            summary.facts = {...facts, failureObserved: failure !== undefined};
          }
          lifecycle.append({kind: 'play.stopped', data: {
            ...lifecycleData(run), startedObserved: run.startedObserved, exit: summary,
          }});
          activeRun = undefined;
          exitedRuns.push(run);
          if (exitedRuns.length > MAX_EXITED_RUNS) exitedRuns.shift();
          break;
        }
      }
      notify();
    },
  };
}

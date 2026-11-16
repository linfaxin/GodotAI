import type {RuntimeDiagnostic, RuntimeSummary} from './runtime-host.js';
export type {RuntimeDiagnostic, RuntimeSummary} from './runtime-host.js';

/** Observations from one run. Missing observations never imply successful cleanup. */
export interface SessionFacts {
  schemaVersion: 1;
  failure?: RuntimeDiagnostic;
  nativeExit?: {code: number};
  forcedTerminationIssued: boolean;
  runtimeSummary: 'sealed' | 'unconfirmed' | 'not-tracked';
  entryCleanup: 'complete' | 'failed' | 'unconfirmed' | 'not-applicable';
  hostCleanup: 'complete' | 'failed' | 'timed-out' | 'unconfirmed';
}

export type SessionExitReason = 'clean-exit' | 'forced-worker-termination' | 'crashed' | 'host-cleanup-failed' | 'cleanup-unconfirmed';
type FactsInput = Partial<Omit<SessionFacts, 'schemaVersion'>>;
type SummaryFactsInput = Partial<Omit<SessionFacts, 'schemaVersion' | 'runtimeSummary' | 'entryCleanup'>>;

function dataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === 'string' && !!descriptor && descriptor.enumerable && 'value' in descriptor;
    });
  } catch { return false; }
}

function dataArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > maximum) return false;
  if (Reflect.ownKeys(value).length !== length.value + 1) return false;
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
}

function boundedString(value: unknown, maximum: number, empty = true): value is string {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}

function oneOf(value: unknown, choices: readonly string[]): value is string {
  return typeof value === 'string' && choices.includes(value);
}

function diagnostic(value: unknown): value is RuntimeDiagnostic {
  return dataRecord(value) &&
    Object.keys(value).every(key => ['kind', 'message', 'stack', 'componentStack'].includes(key)) &&
    oneOf(value.kind, ['caught', 'recoverable', 'uncaught', 'runtime']) &&
    boundedString(value.message, 4096) &&
    (value.stack === undefined || boundedString(value.stack, 32768)) &&
    (value.componentStack === undefined || boundedString(value.componentStack, 8192));
}

/** Validate the wire DTO without running project-provided getters or serializers. */
export function isSessionFacts(value: unknown): value is SessionFacts {
  try {
    if (!dataRecord(value) || Object.keys(value).some(key => ![
      'schemaVersion', 'failure', 'nativeExit', 'forcedTerminationIssued', 'runtimeSummary', 'entryCleanup', 'hostCleanup',
    ].includes(key))) return false;
    if (value.schemaVersion !== 1 || typeof value.forcedTerminationIssued !== 'boolean' ||
      !oneOf(value.runtimeSummary, ['sealed', 'unconfirmed', 'not-tracked']) ||
      !oneOf(value.entryCleanup, ['complete', 'failed', 'unconfirmed', 'not-applicable']) ||
      !oneOf(value.hostCleanup, ['complete', 'failed', 'timed-out', 'unconfirmed'])) return false;
    if (value.failure !== undefined && (!diagnostic(value.failure) || !['uncaught', 'runtime'].includes(value.failure.kind))) return false;
    if (value.nativeExit !== undefined && (!dataRecord(value.nativeExit) || Object.keys(value.nativeExit).length !== 1 ||
      !Number.isSafeInteger(value.nativeExit.code))) return false;
    return true;
  } catch { return false; }
}

/** Construct an owned snapshot rather than retaining a caller's mutable facts. */
export function createSessionFacts(input: FactsInput = {}): SessionFacts {
  const value: SessionFacts = {
    schemaVersion: 1,
    forcedTerminationIssued: input.forcedTerminationIssued ?? false,
    runtimeSummary: input.runtimeSummary ?? 'unconfirmed',
    entryCleanup: input.entryCleanup ?? 'unconfirmed',
    hostCleanup: input.hostCleanup ?? 'unconfirmed',
    ...(input.failure !== undefined ? {failure: input.failure} : {}),
    ...(input.nativeExit !== undefined ? {nativeExit: input.nativeExit} : {}),
  };
  if (!isSessionFacts(value)) throw new Error('E_SESSION_FACTS');
  return Object.freeze({
    ...value,
    ...(value.failure ? {failure: Object.freeze({...value.failure})} : {}),
    ...(value.nativeExit ? {nativeExit: Object.freeze({...value.nativeExit})} : {}),
  });
}

/** Keep diagnosis independent of native exit and forced-stop observations. */
export function sessionExitReason(facts: SessionFacts): SessionExitReason {
  if (!isSessionFacts(facts)) throw new Error('E_SESSION_FACTS');
  if (facts.failure || facts.entryCleanup === 'failed' || (facts.nativeExit && facts.nativeExit.code !== 0)) return 'crashed';
  if (facts.forcedTerminationIssued) return 'forced-worker-termination';
  if (facts.hostCleanup === 'failed' || facts.hostCleanup === 'timed-out') return 'host-cleanup-failed';
  if (!facts.nativeExit || facts.runtimeSummary !== 'sealed' || facts.hostCleanup !== 'complete' ||
    !['complete', 'not-applicable'].includes(facts.entryCleanup)) return 'cleanup-unconfirmed';
  return 'clean-exit';
}

/** Epoch snapshots are bounded plain data; an overflow cannot certify cleanup. */
export function isRuntimeSummary(value: unknown): value is RuntimeSummary {
  try {
    if (!dataRecord(value) || Object.keys(value).some(key => ![
      'schemaVersion', 'epoch', 'sealed', 'failure', 'entries', 'overflow', 'role',
    ].includes(key))) return false;
    if (value.schemaVersion !== 1 || !boundedString(value.epoch, 256, false) || typeof value.sealed !== 'boolean' ||
      typeof value.overflow !== 'boolean' || !dataArray(value.entries, 128) ||
      (value.role !== undefined && !oneOf(value.role, ['host', 'engine', 'script-worker'])) ||
      (value.failure !== undefined && (!diagnostic(value.failure) || !['uncaught', 'runtime'].includes(value.failure.kind)))) return false;
    const ids = new Set<string>();
    for (const entry of value.entries) {
      if (!dataRecord(entry) || Object.keys(entry).some(key => !['entryId', 'state', 'cleanup'].includes(key)) ||
        !boundedString(entry.entryId, 256, false) || ids.has(entry.entryId) ||
        !oneOf(entry.state, ['starting', 'ready', 'closed']) ||
        !oneOf(entry.cleanup, ['pending', 'complete', 'failed', 'unconfirmed', 'not-applicable'])) return false;
      ids.add(entry.entryId);
    }
    return true;
  } catch { return false; }
}

export function runtimeSummaryCleanup(summary: RuntimeSummary | undefined): SessionFacts['entryCleanup'] {
  if (!summary) return 'unconfirmed';
  if (!isRuntimeSummary(summary)) throw new Error('E_RUNTIME_SUMMARY');
  if (summary.entries.some(entry => entry.cleanup === 'failed')) return 'failed';
  if (!summary.sealed || summary.overflow || summary.entries.some(entry => entry.state !== 'closed' ||
    !['complete', 'not-applicable'].includes(entry.cleanup))) return 'unconfirmed';
  if (!summary.entries.length || summary.entries.every(entry => entry.cleanup === 'not-applicable')) return 'not-applicable';
  return 'complete';
}

/** Existing failure wins, so a later source snapshot cannot replace the first fatal. */
export function factsFromRuntimeSummary(summary: RuntimeSummary | undefined, input: SummaryFactsInput = {}): SessionFacts {
  if (summary && !isRuntimeSummary(summary)) throw new Error('E_RUNTIME_SUMMARY');
  const failure = input.failure ?? summary?.failure;
  return createSessionFacts({
    ...input,
    ...(failure ? {failure} : {}),
    runtimeSummary: summary?.sealed && !summary.overflow ? 'sealed' : 'unconfirmed',
    entryCleanup: runtimeSummaryCleanup(summary),
  });
}

/** The owner supplies completeness from its registered source/epoch inventory. */
export function factsFromRuntimeSummaries(summaries: readonly RuntimeSummary[], input: SummaryFactsInput & {allSourcesSealed: boolean}): SessionFacts {
  for (const summary of summaries) if (!isRuntimeSummary(summary)) throw new Error('E_RUNTIME_SUMMARY');
  const {allSourcesSealed, ...facts} = input;
  const states = summaries.map(runtimeSummaryCleanup);
  const sealed = allSourcesSealed && summaries.length > 0 && summaries.every(summary => summary.sealed && !summary.overflow);
  const failure = facts.failure ?? summaries.find(summary => summary.failure)?.failure;
  return createSessionFacts({
    ...facts,
    ...(failure ? {failure} : {}),
    runtimeSummary: sealed ? 'sealed' : 'unconfirmed',
    entryCleanup: states.includes('failed') ? 'failed' : !sealed || states.includes('unconfirmed') ? 'unconfirmed' :
      states.includes('complete') ? 'complete' : 'not-applicable',
  });
}

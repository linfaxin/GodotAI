import {interactionNow, supportsWorkerInteraction} from './worker-interaction.js';
import type {WorkerRunIdentity} from './worker-protocol.js';
import {propertyRecord, validRuntimeString} from './worker-runtime-properties.js';
import type {VerifiedRelease} from '../verified-loader.js';

export const INPUT_SCRIPT_VERSION = 1;
export const INPUT_SCRIPT_DRAIN_MS = 1000;
const BUFFER_BYTES = 4096;
const UINT32_MAX = 0xffffffff;
const UINT64_MAX = 18446744073709551615n;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

export type InputScriptCommand = {actionName: string; pressOffset: number; releaseOffset: number};
export type InputScriptInput = InputScriptCommand & {runId: string; timeoutMs?: number};
export type InputScriptState = {supported: boolean | null; ready: boolean};
export type InputScriptKey = {releaseId: string; requestId: string; sequence: number};
export type InputScriptRequest = InputScriptKey & {command: InputScriptCommand; deadline: number};
export type InputScriptReceipt = InputScriptKey & {run: WorkerRunIdentity};
type Edge = {physics: string; iteration: number};
const reasons = ['invalid_input', 'not_found', 'not_ready', 'unsupported', 'busy', 'timeout', 'cancelled', 'run_ended',
  'dispatch_failed', 'unknown_action', 'action_changed', 'action_released', 'scene_changed', 'input_reset',
  'input_disabled', 'paused', 'hidden', 'transport_lost'] as const;
export type InputScriptReason = typeof reasons[number];
type KnownFailure = {kind: 'not_executed'; source: 'host' | 'worker' | 'native'; reason: InputScriptReason};
type Executed = {source: 'native'; base: string; down: Edge};
type Completed = Executed & {kind: 'completed'; up: Edge; releaseStepCompleted: true; finishedIteration: number};
type Interrupted = Executed & {kind: 'interrupted'; reason: InputScriptReason} &
  ({owner: 'cleared'} | {owner: 'released'; up: Edge; releaseStepCompleted: boolean});
export type InputScriptTerminal = KnownFailure | Completed | Interrupted;
type InputScriptFailure = {ok: false; outcome: 'not_executed' | 'interrupted' | 'outcome_unknown';
  error: {code: InputScriptReason | 'outcome_unknown'; message: string}; receipt?: InputScriptReceipt;
  terminal?: KnownFailure | Interrupted};
export type InputScriptResult = {ok: true; receipt: InputScriptReceipt; result: Completed} | InputScriptFailure;

export function inputScriptFailure(reason: InputScriptReason, receipt?: InputScriptReceipt,
  outcome: InputScriptFailure['outcome'] = 'not_executed', terminal?: KnownFailure | Interrupted): InputScriptFailure {
  return {ok: false, outcome, error: {code: outcome === 'outcome_unknown' ? outcome : reason, message: reason},
    ...(receipt ? {receipt} : {}), ...(terminal ? {terminal} : {})};
}

export function noInputScript(source: KnownFailure['source'], reason: InputScriptReason): KnownFailure {
  return {kind: 'not_executed', source, reason};
}

export function supportsInputScript(release: VerifiedRelease, presentation: 'direct' | 'bitmap' | undefined, userAgent: string) {
  return release.runtimeAbi?.inputScript === INPUT_SCRIPT_VERSION && supportsWorkerInteraction(release, presentation, userAgent);
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function readInputScriptCommand(value: unknown): InputScriptCommand | undefined {
  if (!propertyRecord(value) || Object.keys(value).length !== 3) return;
  const {actionName, pressOffset, releaseOffset} = value;
  if (typeof actionName !== 'string' || actionName.length === 0 || actionName.includes('\0') ||
    !validRuntimeString(actionName, 128) || !integer(pressOffset, 0, 119) || !integer(releaseOffset, pressOffset + 1, 120)) return;
  return {actionName, pressOffset, releaseOffset};
}

export function prepareInputScript(value: unknown, signal: AbortSignal | undefined) {
  try {
    if (!propertyRecord(value) || Object.keys(value).some(key =>
      !['runId', 'timeoutMs', 'actionName', 'pressOffset', 'releaseOffset'].includes(key))) return inputScriptFailure('invalid_input');
    const {runId, timeoutMs = 5000, ...command} = value;
    const checked = readInputScriptCommand(command);
    if (!checked || typeof runId !== 'string' || !runId || runId.length > 256 || !integer(timeoutMs, 1, 30000))
      return inputScriptFailure('invalid_input');
    if (signal !== undefined && readAborted.call(signal)) return inputScriptFailure('cancelled');
    return {ok: true as const, runId, command: checked, deadline: interactionNow() + timeoutMs};
  } catch { return inputScriptFailure('invalid_input'); }
}

export function inputScriptRequestId(runId: string, sequence: number) { return `${runId}:input:${sequence}`; }

export function readInputScriptKey(value: Record<string, unknown>, runId: string, releaseId: string): InputScriptKey | undefined {
  const {sequence, requestId} = value;
  if (value.releaseId !== releaseId || !integer(sequence, 1, UINT32_MAX) || requestId !== inputScriptRequestId(runId, sequence)) return;
  return {releaseId, requestId, sequence};
}

export function readInputScriptRequest(value: Record<string, unknown>, key: InputScriptKey): InputScriptRequest | undefined {
  const {deadline} = value;
  const command = readInputScriptCommand(value.command);
  if (command && typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0 && deadline <= interactionNow() + 30000)
    return {...key, command, deadline};
}

export function matchesInputScript(left: InputScriptKey, right: InputScriptKey | undefined) {
  return !!right && left.sequence === right.sequence && left.requestId === right.requestId && left.releaseId === right.releaseId;
}

function physics(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) return;
  const count = BigInt(value);
  if (count <= UINT64_MAX) return count;
}

function readEdge(value: unknown, base: bigint, offset: number): Edge | undefined {
  if (!propertyRecord(value) || Object.keys(value).length !== 2 || physics(value.physics) !== base + BigInt(offset) ||
    !integer(value.iteration, 0, UINT32_MAX)) return;
  return {physics: value.physics as string, iteration: value.iteration};
}

export function readInputScriptTerminal(value: unknown, command: InputScriptCommand): InputScriptTerminal | undefined {
  if (!propertyRecord(value)) return;
  const reason = reasons.find(item => item === value.reason);
  if (value.kind === 'not_executed' && reason && Object.keys(value).length === 3 &&
    (value.source === 'host' || value.source === 'worker' || value.source === 'native')) return noInputScript(value.source, reason);
  if (value.source !== 'native') return;
  const base = physics(value.base);
  if (base === undefined) return;
  const down = readEdge(value.down, base, command.pressOffset);
  if (!down) return;
  const up = readEdge(value.up, base, command.releaseOffset);
  if (up && ((up.iteration - down.iteration) >>> 0) >= 0x80000000) return;
  const executed = {source: 'native' as const, base: value.base as string, down};
  if (value.kind === 'completed' && up && value.releaseStepCompleted === true && value.finishedIteration === up.iteration &&
    Object.keys(value).length === 7) return {kind: 'completed', ...executed, up, releaseStepCompleted: true, finishedIteration: up.iteration};
  if (value.kind === 'interrupted' && reason) {
    if (value.owner === 'released' && up && typeof value.releaseStepCompleted === 'boolean' && Object.keys(value).length === 8)
      return {kind: 'interrupted', ...executed, reason, owner: 'released', up, releaseStepCompleted: value.releaseStepCompleted};
    if (value.owner === 'cleared' && Object.keys(value).length === 6)
      return {kind: 'interrupted', ...executed, reason, owner: 'cleared'};
  }
}

export function createNativeInputScript(module: Record<string, any>) {
  const abi = module._godotjs_input_script_abi;
  const address = module._godotjs_input_script_buffer;
  const stage = module._godotjs_input_script_stage;
  const cancel = module._godotjs_input_script_cancel;
  const take = module._godotjs_input_script_take;
  if ([abi, address, stage, cancel, take].some(method => typeof method !== 'function') || abi() !== INPUT_SCRIPT_VERSION)
    throw Error('E_INPUT_SCRIPT_ABI');
  function buffer() {
    const start = address() >>> 0;
    const memory = module.HEAPU8;
    if (!(memory instanceof Uint8Array) || !start || start + BUFFER_BYTES > memory.byteLength) throw Error('E_INPUT_SCRIPT_BUFFER');
    return memory.subarray(start, start + BUFFER_BYTES);
  }
  buffer();
  return {
    stage(request: InputScriptRequest) {
      const bytes = encoder.encode(JSON.stringify({...request.command, deadline: request.deadline}));
      if (bytes.length > BUFFER_BYTES) return false;
      buffer().set(bytes);
      const remaining = Math.max(0, Math.min(30000000, Math.floor((request.deadline - interactionNow()) * 1000)));
      return stage(request.sequence, bytes.length, remaining) === 1;
    },
    cancel(sequence: number, reason: 'cancelled' | 'timeout' | 'run_ended' | 'hidden') {
      cancel(sequence, reason === 'timeout' ? 1 : reason === 'run_ended' ? 2 : reason === 'hidden' ? 3 : 0);
    },
    take(request: InputScriptRequest) {
      const size = take(request.sequence);
      if (size === 0) return;
      if (!integer(size, 1, BUFFER_BYTES)) throw Error('E_INPUT_SCRIPT_RESULT');
      const response = readInputScriptTerminal(JSON.parse(decoder.decode(buffer().slice(0, size))), request.command);
      if (!response || response.source !== 'native') throw Error('E_INPUT_SCRIPT_RESULT');
      return response;
    },
  };
}

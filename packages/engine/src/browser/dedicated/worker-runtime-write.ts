import type {VerifiedRelease} from '../verified-loader.js';
import {interactionNow, validInteractionId} from './worker-interaction.js';
import type {WorkerRunConfiguration, WorkerRunIdentity} from './worker-protocol.js';
import {createNativeRuntimeRequest, MAX_OBSERVATION_TIMEOUT_MS, MAX_RUNTIME_REQUEST_BYTES, pathIsCanonical,
  type NativeObservationModule} from './worker-runtime-observation.js';

export const RUNTIME_WRITE_VERSION = 1;
const MAX_INSTANCE_ID = '18446744073709551615';
const encoder = new TextEncoder();
const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const objectConstructorSource = Function.prototype.toString.call(Object);
const errorCodes = ['invalid_input', 'unsupported', 'not_ready', 'busy', 'not_found', 'run_ended',
  'node_not_found', 'node_changed', 'unsupported_node_type', 'dispatch_failed', 'timeout', 'cancelled'] as const;
const unconfirmedReasons = ['timeout', 'cancelled', 'run_ended', 'transport_lost', 'target_changed', 'readback_failed'] as const;

type Position = {x: number; y: number};
export type RuntimeWriteCommand = {
  path: string; expectedInstanceId: string; property: 'position'; value: Position;
};
export type RuntimeSetInput = RuntimeWriteCommand & {runId: string; timeoutMs?: number};
export type RuntimeSetError = typeof errorCodes[number];
export type RuntimeWriteUnconfirmed = typeof unconfirmedReasons[number];
export type RuntimeWriteOutcome =
  | {outcome: 'applied' | 'not_applied'; observedValue: Position}
  | {outcome: 'unconfirmed'; reason: RuntimeWriteUnconfirmed};
type WriteError = {ok: false; error: {code: RuntimeSetError; message: string}};
export type RuntimeWriteResult = {ok: true; result: RuntimeWriteOutcome} | WriteError;
type RuntimeSetReceipt = Omit<RuntimeWriteCommand, 'value'> & {
  requestId: string; run: WorkerRunIdentity; releaseId: string; requestedValue: Position;
};
export type RuntimeSetResult = {ok: true; result: RuntimeSetReceipt & RuntimeWriteOutcome} |
  (WriteError & {requestId?: string});
export type RuntimeWriteState = {supported: boolean | null; ready: boolean; version?: typeof RUNTIME_WRITE_VERSION};

export const runtimeWriteError = (code: RuntimeSetError): WriteError => ({ok: false, error: {code, message: code}});
export const runtimeWriteUnconfirmed = (reason: RuntimeWriteUnconfirmed): RuntimeWriteResult =>
  ({ok: true, result: {outcome: 'unconfirmed', reason}});

export function supportsWorkerRuntimeWrite(release: Pick<VerifiedRelease, 'runtimeAbi'>,
  presentation: WorkerRunConfiguration['presentationBackend']): boolean {
  return release.runtimeAbi?.runtimeWrite === RUNTIME_WRITE_VERSION && presentation === 'direct';
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    if (Object.getPrototypeOf(prototype) !== null || typeof constructor !== 'function' ||
        Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value !== prototype ||
        Function.prototype.toString.call(constructor) !== objectConstructorSource) return false;
  }
  return Reflect.ownKeys(value).every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && field?.enumerable && 'value' in field;
  });
}

function instanceId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) &&
    (value.length < MAX_INSTANCE_ID.length || value <= MAX_INSTANCE_ID);
}

function position(value: unknown): Position | undefined {
  if (!record(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'x') || !Object.hasOwn(value, 'y')) return;
  const {x, y} = value;
  if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) return {x, y};
}

export function readRuntimeWriteCommand(input: unknown): RuntimeWriteCommand | undefined {
  if (!record(input) || Object.keys(input).length !== 4) return;
  const {path, expectedInstanceId, property, value} = input;
  if (!pathIsCanonical(path) || !instanceId(expectedInstanceId) || property !== 'position') return;
  const coordinates = position(value);
  if (!coordinates) return;
  const result: RuntimeWriteCommand = {path, expectedInstanceId, property, value: coordinates};
  if (encoder.encode(JSON.stringify(result)).byteLength <= MAX_RUNTIME_REQUEST_BYTES) return result;
}

export function prepareRuntimeSet(input: unknown, signal?: AbortSignal):
  {ok: true; result: {runId: string; timeoutMs: number; command: RuntimeWriteCommand}} | WriteError {
  try {
    if (!record(input)) return runtimeWriteError('invalid_input');
    const {runId, timeoutMs = 5000, ...command} = input;
    if (!validInteractionId(runId) || typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 || timeoutMs > MAX_OBSERVATION_TIMEOUT_MS) return runtimeWriteError('invalid_input');
    const prepared = readRuntimeWriteCommand(command);
    if (!prepared) return runtimeWriteError('invalid_input');
    if (signal !== undefined && readAborted.call(signal)) return runtimeWriteError('cancelled');
    return {ok: true, result: {runId, timeoutMs, command: prepared}};
  } catch {
    return runtimeWriteError('invalid_input');
  }
}

export function readRuntimeWriteResult(value: unknown): RuntimeWriteResult | undefined {
  if (!record(value) || Object.keys(value).length !== 2) return;
  if (value.ok === false && record(value.error) && Object.keys(value.error).length === 2) {
    const {code, message} = value.error;
    if (errorCodes.includes(code as RuntimeSetError) && typeof message === 'string' && message.length <= 512)
      return {ok: false, error: {code: code as RuntimeSetError, message}};
  }
  if (value.ok !== true || !record(value.result) || Object.keys(value.result).length !== 2) return;
  const {outcome, reason, observedValue} = value.result;
  if (outcome === 'unconfirmed' && unconfirmedReasons.includes(reason as RuntimeWriteUnconfirmed))
    return runtimeWriteUnconfirmed(reason as RuntimeWriteUnconfirmed);
  if (outcome === 'applied' || outcome === 'not_applied') {
    const observed = position(observedValue);
    if (observed) return {ok: true, result: {outcome, observedValue: observed}};
  }
}

interface NativeWriteModule extends NativeObservationModule {
  _godotjs_runtime_write_abi?: () => number;
  _godotjs_runtime_write_execute?: (bytes: number) => number;
}

export function createNativeRuntimeWriter(module: NativeWriteModule) {
  const abi = module._godotjs_runtime_write_abi;
  const execute = module._godotjs_runtime_write_execute;
  if (typeof abi !== 'function' || abi() !== RUNTIME_WRITE_VERSION || typeof execute !== 'function')
    throw Error('E_RUNTIME_WRITE_ABI');
  const request = createNativeRuntimeRequest(module, execute);
  return (command: RuntimeWriteCommand, deadline: number): RuntimeWriteResult => {
    try {
      const result = request(encoder.encode(JSON.stringify(command)), () => interactionNow() < deadline);
      if (result === undefined) return runtimeWriteError('timeout');
      return readRuntimeWriteResult(result) ?? runtimeWriteUnconfirmed('readback_failed');
    } catch {
      return runtimeWriteUnconfirmed('readback_failed');
    }
  };
}

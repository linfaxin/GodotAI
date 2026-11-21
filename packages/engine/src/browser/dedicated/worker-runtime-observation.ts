import {validInteractionId, validInteractionSequence} from './worker-interaction.js';
import type {WorkerRunIdentity} from './worker-protocol.js';
import type {VerifiedRelease} from '../verified-loader.js';

export const RUNTIME_OBSERVATION_VERSION = 1;
export const MAX_OBSERVATION_TIMEOUT_MS = 30_000;
export const MAX_RUNTIME_REQUEST_BYTES = 4096;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_PATH_BYTES = 2048;
const MAX_PATH_SEGMENTS = 128;
const MAX_NODES = 500;
const properties = ['position', 'rotation', 'visible'] as const;
const truncationReasons = ['node_limit', 'work_budget', 'byte_budget'] as const;
const observationErrors = [
  'invalid_input', 'cancelled', 'not_found', 'run_ended', 'not_ready', 'unsupported',
  'busy', 'timeout', 'node_not_found', 'observation_failed',
] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

export type ObservationError = typeof observationErrors[number];
export type ObservationResult<T> = {ok: true; result: T} | {ok: false; error: {code: ObservationError; message: string}};
export type RuntimeObservedProperty = typeof properties[number];
export type RuntimeTreeInput = {runId: string; path?: string; depth?: number; limit?: number; timeoutMs?: number};
export type RuntimeNodeInput = {runId: string; path: string; properties: readonly RuntimeObservedProperty[]; timeoutMs?: number};
export type RuntimeObservationState = {supported: boolean | null; ready: boolean; version?: typeof RUNTIME_OBSERVATION_VERSION};
export interface RuntimeObservedNode {
  name: string;
  type: string;
  path: string;
  parentPath: string | null;
  instanceId: string;
}
export type RuntimePropertySample =
  | {name: RuntimeObservedProperty; value: number | boolean | {x: number; y: number}}
  | {name: RuntimeObservedProperty; unavailable: 'unsupported_node_type' | 'non_finite'};
interface RuntimeTreeSample {
  nodes: RuntimeObservedNode[];
  truncated: boolean;
  truncationReason?: typeof truncationReasons[number];
}
interface RuntimeNodeSample {
  node: RuntimeObservedNode;
  properties: RuntimePropertySample[];
}
interface RuntimeSnapshotIdentity {
  run: WorkerRunIdentity;
  releaseId: string;
  requestId: string;
  sampleSeq: number;
}
export type RuntimeTreeSnapshot = RuntimeTreeSample & RuntimeSnapshotIdentity;
export type RuntimeNodeSnapshot = RuntimeNodeSample & RuntimeSnapshotIdentity;

export type RuntimeObservationQuery =
  | {kind: 'tree'; path?: string; depth: number; limit: number}
  | {kind: 'node'; path: string; properties: RuntimeObservedProperty[]};
export type RuntimeObservationSample = RuntimeTreeSample | RuntimeNodeSample;
export type PreparedRuntimeObservation = {runId: string; timeoutMs: number; query: RuntimeObservationQuery};

export const observationOk = <T>(result: T): ObservationResult<T> => ({ok: true, result});
export const observationError = (code: ObservationError): ObservationResult<never> => ({ok: false, error: {code, message: code}});
export const supportsWorkerObservation = (release: Pick<VerifiedRelease, 'runtimeAbi'>): boolean =>
  release.runtimeAbi?.observation === RUNTIME_OBSERVATION_VERSION;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function pathIsCanonical(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > MAX_PATH_BYTES ||
      /[:\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value) || encoder.encode(value).byteLength > MAX_PATH_BYTES) return false;
  const segments = value.slice(1).split('/');
  return segments.length <= MAX_PATH_SEGMENTS && segments.every(segment =>
    segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('%'));
}

export function readRuntimeObservationQuery(value: unknown): RuntimeObservationQuery | undefined {
  if (!record(value)) return;
  if (value.kind === 'tree' && (value.path === undefined || pathIsCanonical(value.path)) &&
      integer(value.depth, 0, 8) && integer(value.limit, 1, MAX_NODES)) {
    return {kind: 'tree', ...(value.path === undefined ? {} : {path: value.path}), depth: value.depth, limit: value.limit};
  }
  if (value.kind !== 'node' || !pathIsCanonical(value.path) || !Array.isArray(value.properties) ||
      value.properties.length === 0 || value.properties.length > properties.length) return;
  const requested = [...value.properties];
  if (!requested.every(property => properties.includes(property)) || new Set(requested).size !== requested.length) return;
  return {kind: 'node', path: value.path, properties: requested};
}

/** Validates public input before a host performs its own run lookup. */
export function prepareRuntimeObservation(
  kind: RuntimeObservationQuery['kind'], input: unknown, signal?: AbortSignal,
): ObservationResult<PreparedRuntimeObservation> {
  try {
    if (!record(input) || !validInteractionId(input.runId)) return observationError('invalid_input');
    const timeoutMs = input.timeoutMs === undefined ? 5000 : input.timeoutMs;
    if (!integer(timeoutMs, 1, MAX_OBSERVATION_TIMEOUT_MS)) return observationError('invalid_input');
    const query = readRuntimeObservationQuery(kind === 'tree' ?
      {kind, path: input.path, depth: input.depth === undefined ? 2 : input.depth, limit: input.limit === undefined ? 200 : input.limit} :
      {kind, path: input.path, properties: input.properties});
    if (!query || encoder.encode(JSON.stringify(query)).byteLength > MAX_RUNTIME_REQUEST_BYTES) return observationError('invalid_input');
    if (signal !== undefined && readAborted.call(signal)) return observationError('cancelled');
    return observationOk({runId: input.runId, timeoutMs, query});
  } catch {
    return observationError('invalid_input');
  }
}

function readNode(value: unknown): RuntimeObservedNode | undefined {
  if (!record(value)) return;
  const {name, type, path, parentPath, instanceId} = value;
  if (typeof name !== 'string' || !name.length || name.length > MAX_PATH_BYTES || typeof type !== 'string' ||
      !type.length || type.length > 256 || !pathIsCanonical(path) || (parentPath !== null && !pathIsCanonical(parentPath)) ||
      typeof instanceId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(instanceId)) return;
  if (!path.endsWith('/' + name) || (parentPath !== null && path !== parentPath + '/' + name)) return;
  return {name, type, path, parentPath, instanceId};
}

function readProperty(name: RuntimeObservedProperty, value: unknown): RuntimePropertySample | undefined {
  if (!record(value) || value.name !== name) return;
  if (value.unavailable === 'unsupported_node_type' || value.unavailable === 'non_finite')
    return {name, unavailable: value.unavailable};
  if (name === 'visible' && typeof value.value === 'boolean') return {name, value: value.value};
  if (name === 'rotation' && typeof value.value === 'number' && Number.isFinite(value.value)) return {name, value: value.value};
  if (name === 'position' && record(value.value)) {
    const {x, y} = value.value;
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) return {name, value: {x, y}};
  }
}

function boundedSample(sample: RuntimeObservationSample): ObservationResult<RuntimeObservationSample> | undefined {
  const response = observationOk(sample);
  if (encoder.encode(JSON.stringify(response)).byteLength <= MAX_OUTPUT_BYTES) return response;
}

export function readRuntimeObservationResult(
  query: RuntimeObservationQuery, value: unknown,
): ObservationResult<RuntimeObservationSample> | undefined {
  if (!record(value)) return;
  if (value.ok === false && record(value.error) && typeof value.error.code === 'string' &&
      observationErrors.includes(value.error.code as ObservationError) &&
      typeof value.error.message === 'string' && value.error.message.length <= 512) {
    return {ok: false, error: {code: value.error.code as ObservationError, message: value.error.message}};
  }
  if (value.ok !== true || !record(value.result)) return;
  if (query.kind === 'node') {
    const node = readNode(value.result.node);
    if (!node || node.path !== query.path || !Array.isArray(value.result.properties) ||
        value.result.properties.length !== query.properties.length) return;
    const samples: RuntimePropertySample[] = [];
    for (const [index, name] of query.properties.entries()) {
      const sample = readProperty(name, value.result.properties[index]);
      if (!sample) return;
      samples.push(sample);
    }
    return boundedSample({node, properties: samples});
  }
  const {nodes, truncated, truncationReason} = value.result;
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > query.limit || typeof truncated !== 'boolean' ||
      (truncated ? !truncationReasons.includes(truncationReason as typeof truncationReasons[number]) : truncationReason !== undefined)) return;
  const result: RuntimeObservedNode[] = [];
  const depths = new Map<string, number>();
  for (const raw of nodes) {
    const node = readNode(raw);
    if (!node || depths.has(node.path)) return;
    if (result.length === 0) {
      if (node.parentPath !== null || (query.path !== undefined && node.path !== query.path)) return;
      depths.set(node.path, 0);
    } else {
      if (node.parentPath === null) return;
      const parentDepth = depths.get(node.parentPath);
      if (parentDepth === undefined || parentDepth >= query.depth) return;
      depths.set(node.path, parentDepth + 1);
    }
    result.push(node);
  }
  return boundedSample({nodes: result, truncated, ...(truncated ? {truncationReason: truncationReason as typeof truncationReasons[number]} : {})});
}

export function readRuntimeObservationReply(
  query: RuntimeObservationQuery, reply: {result?: unknown; sampleSeq?: unknown},
): ObservationResult<(RuntimeObservationSample & {sampleSeq: number})> {
  const result = readRuntimeObservationResult(query, reply.result);
  if (!result || (result.ok && !validInteractionSequence(reply.sampleSeq))) return observationError('observation_failed');
  return result.ok ? observationOk({...result.result, sampleSeq: reply.sampleSeq as number}) : result;
}

export interface NativeObservationModule {
  HEAPU8?: Uint8Array;
  _godotjs_runtime_observation_abi?: () => number;
  _godotjs_runtime_observation_buffer?: () => number;
  _godotjs_runtime_observation_sample?: (inputBytes: number) => number;
}

function memoryRange(module: NativeObservationModule, pointer: number, length: number): Uint8Array {
  const heap = module.HEAPU8;
  if (!(heap instanceof Uint8Array) || !Number.isSafeInteger(pointer) || pointer < 1 ||
      length > heap.byteLength - pointer) throw Error('E_RUNTIME_OBSERVATION_BUFFER');
  return heap.subarray(pointer, pointer + length);
}

export function createNativeRuntimeRequest(module: NativeObservationModule, execute: (bytes: number) => number) {
  const buffer = module._godotjs_runtime_observation_buffer;
  if (typeof buffer !== 'function') throw Error('E_RUNTIME_OBSERVATION_BUFFER');
  memoryRange(module, buffer(), MAX_OUTPUT_BYTES);
  return (input: Uint8Array, beforeExecute?: () => boolean): unknown => {
    if (input.byteLength > MAX_RUNTIME_REQUEST_BYTES) throw Error('E_RUNTIME_OBSERVATION_BUFFER');
    const pointer = buffer();
    memoryRange(module, pointer, input.byteLength).set(input);
    if (beforeExecute && !beforeExecute()) return undefined;
    const length = execute(input.byteLength);
    if (!integer(length, 1, MAX_OUTPUT_BYTES)) throw Error('E_RUNTIME_OBSERVATION_BUFFER');
    // WASM may grow while executing the request. Decode from the current heap
    // before another call can reuse the shared buffer.
    return JSON.parse(decoder.decode(memoryRange(module, pointer, length)));
  };
}

export function createNativeRuntimeSampler(module: NativeObservationModule) {
  const abi = module._godotjs_runtime_observation_abi;
  const buffer = module._godotjs_runtime_observation_buffer;
  const sample = module._godotjs_runtime_observation_sample;
  if (typeof abi !== 'function' || abi() !== RUNTIME_OBSERVATION_VERSION ||
      typeof buffer !== 'function' || typeof sample !== 'function') throw Error('E_RUNTIME_OBSERVATION_ABI');
  const request = createNativeRuntimeRequest(module, sample);
  return (query: RuntimeObservationQuery): ObservationResult<RuntimeObservationSample> => {
    try {
      const input = encoder.encode(JSON.stringify(query));
      if (input.byteLength > MAX_RUNTIME_REQUEST_BYTES) return observationError('invalid_input');
      return readRuntimeObservationResult(query, request(input)) ?? observationError('observation_failed');
    } catch {
      return observationError('observation_failed');
    }
  };
}

interface ObservationModuleHooks {
  godotWorkerEndIteration?: (iteration: number, serial: number) => void;
  postMainLoop?: (...args: unknown[]) => unknown;
}

export function installRuntimeObservationHooks(module: ObservationModuleHooks, observe: () => void): () => void {
  const priorEnd = module.godotWorkerEndIteration, priorPost = module.postMainLoop;
  let completed = false;
  const end = function (this: unknown, iteration: number, serial: number) {
    priorEnd?.call(this, iteration, serial);
    completed = true;
  };
  const post = function (this: unknown, ...args: unknown[]) {
    const shouldObserve = completed;
    completed = false;
    const result = priorPost?.apply(this, args);
    if (shouldObserve) observe();
    return result;
  };
  module.godotWorkerEndIteration = end;
  module.postMainLoop = post;
  return () => {
    if (module.godotWorkerEndIteration === end) module.godotWorkerEndIteration = priorEnd;
    if (module.postMainLoop === post) module.postMainLoop = priorPost;
  };
}

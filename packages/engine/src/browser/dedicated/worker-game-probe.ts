import {interactionNow, isCapturedFrame, validInteractionId, validInteractionSequence, MAX_CAPTURE_DIMENSION, type CapturedFrame} from './worker-interaction.js';
import {pathIsCanonical, readRuntimeObservationResult, MAX_RUNTIME_REQUEST_BYTES, MAX_OBSERVATION_TIMEOUT_MS, type NativeObservationModule, type RuntimeObservedNode} from './worker-runtime-observation.js';
import {snapshotRuntimePropertyData, propertyRecord, validPropertyName} from './worker-runtime-properties.js';
import type {WorkerRunIdentity} from './worker-protocol.js';
import type {VerifiedRelease} from '../verified-loader.js';

export const GAME_PROBE_VERSION = 1;
export type GameProbeState = {supported: boolean | null; ready: boolean; version?: 1};
export type GameProbeProperty = {path: string; property: string};
export interface GameProbeInput {
  runId: string;
  props?: readonly GameProbeProperty[];
  tree?: {path?: string; depth?: number; limit?: number};
  screenshot?: boolean;
  maxDimension?: number;
  timeoutMs?: number;
}
export type GameProbeQuery = {
  props: GameProbeProperty[];
  tree?: {path?: string; depth: number; limit: number};
  screenshot: boolean;
  maxDimension: number;
};
type PropertyReason = 'node_not_found' | 'unsupported_property' | 'unsupported_node_type' | 'non_finite';
type PropertySample = GameProbeProperty & (
  {status: 'value'; instanceId: string; value: boolean | number | {x: number; y: number}} |
  {status: 'unavailable'; instanceId?: string; reason: PropertyReason}
);
type TreeSample = {status: 'not_requested'} | {status: 'root_missing'; path: string} |
  {status: 'sampled'; nodes: RuntimeObservedNode[]; truncated: boolean; truncationReason?: string};
type GameProbeSample = {iteration: number; renderSerial?: number; properties: PropertySample[]; tree: TreeSample};
export type GameProbeData = Pick<GameProbeSample, 'properties' | 'tree'> & (
  {mode: 'state'; frame: {iteration: number}; image: null} |
  {mode: 'rendered'; frame: {iteration: number; renderSerial: number}; image: CapturedFrame}
);
export type GameProbeReceipt = {run: WorkerRunIdentity; releaseId: string; requestId: string};
export type GameProbeError = 'invalid_input' | 'cancelled' | 'timeout' | 'not_found' | 'not_ready' |
  'unsupported' | 'busy' | 'run_ended' | 'probe_failed' | 'capture_failed';
type ProbeFailure = {ok: false; error: {code: GameProbeError; message: string; reason?: string}; receipt?: GameProbeReceipt};
export type GameProbeResult = {ok: true; result: GameProbeData & GameProbeReceipt} | ProbeFailure;
type NativeResult = {ok: true; result: GameProbeSample} | ProbeFailure;
type WireResult = {ok: true; result: GameProbeData} | ProbeFailure;

const propertyReasons = ['node_not_found', 'unsupported_property', 'unsupported_node_type', 'non_finite'];
const errorCodes = ['invalid_input', 'cancelled', 'timeout', 'not_found', 'not_ready', 'unsupported', 'busy', 'run_ended', 'probe_failed', 'capture_failed'];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const integer = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const only = (input: Record<string, unknown>, keys: string[]) => Object.keys(input).every(key => keys.includes(key));
export const gameProbeError = (code: GameProbeError, reason?: string, receipt?: GameProbeReceipt): ProbeFailure =>
  ({ok: false, error: {code, message: code, ...(reason ? {reason} : {})}, ...(receipt ? {receipt} : {})});

export function supportsGameProbe(release: Pick<VerifiedRelease, 'runtimeAbi' | 'profile' | 'engineTarget' | 'execution'>, presenter?: string) {
  return release.runtimeAbi?.gameProbe === 1 && release.profile === 'full-engine-v1' &&
    release.engineTarget === 'template_debug' && release.execution?.executionModel === 'window' &&
    release.execution.wasmThreads === false && presenter === 'direct';
}

export function readGameProbeQuery(raw: unknown): GameProbeQuery | undefined {
  if (!propertyRecord(raw) || !only(raw, ['props', 'tree', 'screenshot', 'maxDimension'])) return;
  const {props = [], screenshot = true, maxDimension = MAX_CAPTURE_DIMENSION} = raw;
  if (!Array.isArray(props) || props.length > 16 || typeof screenshot !== 'boolean' ||
      !integer(maxDimension, 16, MAX_CAPTURE_DIMENSION)) return;
  const paths = new Set<string>();
  const properties: GameProbeProperty[] = [];
  for (const item of props) {
    if (!propertyRecord(item) || !only(item, ['path', 'property']) || !pathIsCanonical(item.path) ||
        !validPropertyName(item.property) || /[:\u0000-\u001f\u007f]/u.test(item.property)) return;
    const key = item.path + ':' + item.property;
    if (paths.has(key)) return;
    paths.add(key);
    properties.push({path: item.path, property: item.property});
  }
  let tree: GameProbeQuery['tree'];
  if (Object.hasOwn(raw, 'tree')) {
    const input = raw.tree;
    if (!propertyRecord(input) || !only(input, ['path', 'depth', 'limit'])) return;
    const {path, depth = 2, limit = 200} = input;
    if ((path !== undefined && !pathIsCanonical(path)) || !integer(depth, 1, 8) || !integer(limit, 1, 500)) return;
    tree = {...(path !== undefined ? {path} : {}), depth, limit};
  }
  const query = {props: properties, screenshot, maxDimension, ...(tree ? {tree} : {})};
  if (encoder.encode(JSON.stringify(query)).byteLength <= MAX_RUNTIME_REQUEST_BYTES) return query;
}

export function prepareGameProbe(input: unknown, signal?: AbortSignal) {
  try {
    const raw = snapshotRuntimePropertyData(input);
    if (!propertyRecord(raw)) return gameProbeError('invalid_input');
    const {runId, timeoutMs = 5000, ...rest} = raw;
    const query = readGameProbeQuery(rest);
    if (!query || !validInteractionId(runId) || !integer(timeoutMs, 1, MAX_OBSERVATION_TIMEOUT_MS))
      return gameProbeError('invalid_input');
    if (signal !== undefined && readAborted.call(signal)) return gameProbeError('cancelled');
    return {ok: true as const, result: {runId, query, timeoutMs}};
  } catch {
    return gameProbeError('invalid_input');
  }
}

export function readGameProbeRequest(raw: Record<string, unknown>) {
  if (!validInteractionId(raw.requestId) || typeof raw.deadline !== 'number' || !Number.isFinite(raw.deadline)) return;
  const query = readGameProbeQuery(raw.query);
  if (query) return {requestId: raw.requestId, deadline: raw.deadline, query};
}

export function readGameProbeSequence(requestId: unknown, runId: string): number | undefined {
  const prefix = runId + ':probe:';
  if (!validInteractionId(requestId) || !requestId.startsWith(prefix)) return;
  const value = Number(requestId.slice(prefix.length));
  if (validInteractionSequence(value) && requestId === prefix + value) return value;
}

function readFailure(raw: Record<string, unknown>): ProbeFailure | undefined {
  const {error} = raw;
  if (raw.ok !== false || !propertyRecord(error) || typeof error.code !== 'string' || !errorCodes.includes(error.code)) return;
  const reason = typeof error.reason === 'string' ? error.reason : error.message;
  return gameProbeError(error.code as GameProbeError, typeof reason === 'string' && reason.length <= 128 ? reason : undefined);
}

function readSample(query: GameProbeQuery, raw: unknown): GameProbeSample | undefined {
  if (!propertyRecord(raw) || !validInteractionSequence(raw.iteration) ||
      (query.screenshot ? !validInteractionSequence(raw.renderSerial) : raw.renderSerial !== undefined) ||
      !Array.isArray(raw.properties) || raw.properties.length !== query.props.length || !propertyRecord(raw.tree)) return;
  const properties: PropertySample[] = [];
  for (const [index, target] of query.props.entries()) {
    const item: unknown = raw.properties[index];
    if (!propertyRecord(item) || item.path !== target.path || item.property !== target.property) return;
    if (item.status === 'unavailable') {
      if (typeof item.reason !== 'string' || !propertyReasons.includes(item.reason) ||
          (item.reason === 'node_not_found' ? item.instanceId !== undefined : !instance(item.instanceId))) return;
      properties.push({...target, status: 'unavailable', reason: item.reason as PropertyReason,
        ...(typeof item.instanceId === 'string' ? {instanceId: item.instanceId} : {})});
    } else if (item.status === 'value' && instance(item.instanceId) && matchesProperty(target.property, item.value)) {
      properties.push({...target, status: 'value', instanceId: item.instanceId, value: item.value});
    } else return;
  }
  let tree: TreeSample;
  if (!query.tree && raw.tree.status === 'not_requested') tree = {status: 'not_requested'};
  else if (query.tree && raw.tree.status === 'root_missing' && raw.tree.path === query.tree.path && typeof raw.tree.path === 'string')
    tree = {status: 'root_missing', path: raw.tree.path};
  else if (query.tree && raw.tree.status === 'sampled') {
    const result = readRuntimeObservationResult({kind: 'tree', ...query.tree}, {ok: true, result: raw.tree});
    if (!result?.ok || !('nodes' in result.result)) return;
    tree = {status: 'sampled', ...result.result};
  } else return;
  return {iteration: raw.iteration, ...(typeof raw.renderSerial === 'number' ? {renderSerial: raw.renderSerial} : {}), properties, tree};
}

function instance(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
}
function matchesProperty(name: string, value: unknown): value is boolean | number | {x: number; y: number} {
  if (name === 'visible') return typeof value === 'boolean';
  if (name === 'rotation') return typeof value === 'number' && Number.isFinite(value);
  return name === 'position' && propertyRecord(value) && only(value, ['x', 'y']) && typeof value.x === 'number' && Number.isFinite(value.x) &&
    typeof value.y === 'number' && Number.isFinite(value.y);
}

const pngCrcTable = Uint32Array.from({length: 256}, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc;
});

function completeCapturePng({bytes, width, height}: CapturedFrame): boolean {
  const png = new DataView(bytes), data = new Uint8Array(bytes);
  const ihdr = 0x49484452, idat = 0x49444154, iend = 0x49454e44;
  if (png.byteLength < 33 || png.getUint32(8) !== 13 || png.getUint32(12) !== ihdr ||
      png.getUint32(16) !== width || png.getUint32(20) !== height) return false;
  let idatBytes = 0, endedIdat = false;
  for (let offset = 8; offset + 12 <= png.byteLength;) {
    const size = png.getUint32(offset), type = png.getUint32(offset + 4), end = offset + 8 + size;
    if (end + 4 > png.byteLength || (offset > 8 && type === ihdr)) return false;
    let crc = 0xffffffff;
    for (let index = offset + 4; index < end; index++) crc = (crc >>> 8) ^ pngCrcTable[(crc ^ data[index]) & 0xff];
    if ((~crc >>> 0) !== png.getUint32(end)) return false;
    if (type === iend) return size === 0 && idatBytes > 0 && end + 4 === png.byteLength;
    if (type === idat) {
      if (endedIdat) return false;
      idatBytes += size;
    } else if (idatBytes > 0) endedIdat = true;
    offset = end + 4;
  }
  return false;
}

export function readGameProbeWireResult(query: GameProbeQuery, value: unknown, minGeometryEpoch = 0): WireResult | undefined {
  if (!propertyRecord(value)) return;
  if (value.ok === false) return readFailure(value);
  const raw = value.result;
  if (value.ok !== true || !propertyRecord(raw) || !propertyRecord(raw.frame) || !only(raw.frame, ['iteration', 'renderSerial'])) return;
  const sample = readSample(query, {...raw.frame, properties: raw.properties, tree: raw.tree});
  if (!sample) return;
  const {properties, tree, iteration, renderSerial} = sample;
  if (!query.screenshot && raw.mode === 'state' && raw.image === null)
    return {ok: true, result: {mode: 'state', frame: {iteration}, image: null, properties, tree}};
  if (query.screenshot && typeof renderSerial === 'number' && raw.mode === 'rendered' && isCapturedFrame(raw.image) &&
      raw.image.iteration === iteration && raw.image.renderSerial === renderSerial && raw.image.geometry.epoch >= minGeometryEpoch) {
    const image = raw.image, {dpr, width, height} = image.geometry;
    const scale = Math.min(1, query.maxDimension / Math.max(image.sourceWidth, image.sourceHeight));
    if (!Number.isFinite(dpr) || dpr <= 0 || dpr > 16 || image.sourceWidth !== Math.floor(width * dpr) ||
        image.sourceHeight !== Math.floor(height * dpr) || image.width !== Math.max(1, Math.round(image.sourceWidth * scale)) ||
        image.height !== Math.max(1, Math.round(image.sourceHeight * scale))) return;
    if (!completeCapturePng(image)) return;
    return {ok: true, result: {mode: 'rendered', frame: {iteration, renderSerial}, image, properties, tree}};
  }
}

export function attachGameProbeReceipt(result: WireResult, receipt: GameProbeReceipt): GameProbeResult {
  if (!result.ok) return {...result, receipt};
  const data = {...result.result, ...receipt};
  const projectedImage = data.image ? {...data.image, bytes: undefined} : null;
  const projection = {...data, image: projectedImage};
  const size = () => encoder.encode(JSON.stringify({ok: true, result: projection})).byteLength;
  if (size() > 65536 && projection.tree.status === 'sampled') {
    const tree = {...projection.tree, nodes: [...projection.tree.nodes], truncated: true, truncationReason: 'byte_budget'};
    projection.tree = data.tree = tree;
    while (tree.nodes.length > 1 && size() > 65536) tree.nodes.pop();
  }
  return size() <= 65536 ? {ok: true, result: data} : gameProbeError('probe_failed', 'result_budget', receipt);
}

interface GameProbeModule extends NativeObservationModule {
  _godotjs_game_probe_abi?: () => number;
  _godotjs_game_probe_stage?: (length: number, remainingUs: number) => number;
  _godotjs_game_probe_take?: () => number;
  _godotjs_game_probe_clear?: () => void;
}

export function createNativeGameProbe(module: GameProbeModule) {
  const {_godotjs_game_probe_stage: stage, _godotjs_game_probe_take: take, _godotjs_game_probe_clear: clear,
    _godotjs_runtime_observation_buffer: buffer} = module;
  if (module._godotjs_game_probe_abi?.() !== GAME_PROBE_VERSION || !stage || !take || !clear || !buffer)
    throw Error('E_GAME_PROBE_ABI');
  const memory = (length: number) => {
    const heap = module.HEAPU8, start = buffer();
    if (!heap || !integer(start, 1, heap.byteLength - length)) throw Error('E_GAME_PROBE_BUFFER');
    return heap.subarray(start, start + length);
  };
  return {
    stage(query: GameProbeQuery, deadline: number) {
      const input = encoder.encode(JSON.stringify(query));
      memory(input.length).set(input);
      const remainingUs = Math.min(30_000_000, Math.floor((deadline - interactionNow()) * 1000));
      return remainingUs > 0 && stage(input.length, remainingUs) === 1;
    },
    take(query: GameProbeQuery): NativeResult | undefined {
      const length = take();
      if (!length) return;
      if (!integer(length, 1, 65536)) return gameProbeError('probe_failed', 'result_budget');
      const raw: unknown = JSON.parse(decoder.decode(memory(length)));
      if (!propertyRecord(raw)) return gameProbeError('probe_failed', 'invalid_result');
      if (raw.ok === false) return readFailure(raw) ?? gameProbeError('probe_failed', 'invalid_result');
      const result = readSample(query, raw.result);
      return result ? {ok: true, result} : gameProbeError('probe_failed', 'invalid_result');
    },
    clear,
  };
}

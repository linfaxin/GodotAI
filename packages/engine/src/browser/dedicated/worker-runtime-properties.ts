import type {VerifiedRelease} from '../verified-loader.js';
import type {WorkerRunConfiguration, WorkerRunIdentity} from './worker-protocol.js';
import {interactionNow, validInteractionId} from './worker-interaction.js';
import {MAX_RUNTIME_REQUEST_BYTES, MAX_OBSERVATION_TIMEOUT_MS, pathIsCanonical, type NativeObservationModule} from './worker-runtime-observation.js';

export {pathIsCanonical} from './worker-runtime-observation.js';
export const RUNTIME_PROPERTIES_VERSION = 1;
export const MAX_RUNTIME_PROPERTIES_RESULT_BYTES = 65_536;
export const MAX_RUNTIME_PROPERTY_STRING_BYTES = 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const objectConstructorSource = Function.prototype.toString.call(Object);
const runtimeTypes = ['bool', 'int', 'float', 'string', 'vector2'] as const;
const errors = ['invalid_input', 'unsupported', 'not_found', 'run_ended', 'not_ready', 'busy', 'node_not_found', 'node_changed',
  'property_not_found', 'property_read_only', 'type_mismatch', 'out_of_range', 'dispatch_failed', 'timeout', 'cancelled'] as const;
const reasons = ['getter_failed', 'target_changed', 'type_mismatch', 'out_of_range', 'value_too_large', 'output_budget',
  'encoding_failed', 'setter_failed', 'readback_failed', 'timeout', 'cancelled', 'run_ended', 'transport_lost'] as const;
const interruptionReasons = ['timeout', 'cancelled', 'run_ended', 'transport_lost'] as const;
const scanReasons = ['item_limit', 'metadata_limit', 'inheritance_limit', 'output_budget'] as const;
const unsupportedReasons = ['unsupported_type', 'unsupported_export_type', 'read_only', 'no_native_getter', 'no_native_setter'] as const;

export type RuntimeType = typeof runtimeTypes[number];
export type RuntimeValue = {type: 'bool'; value: boolean} | {type: 'int'; value: number} | {type: 'float'; value: number} |
  {type: 'string'; value: string} | {type: 'vector2'; value: {x: number; y: number}};
export type PropertyTarget = {runId: string; path: string; expectedInstanceId: string; timeoutMs?: number};
export type DescribeInput = PropertyTarget & ({names?: never; limit?: number} | {names: readonly string[]; limit?: never});
export type ReadInput = PropertyTarget & {properties: readonly {name: string; expectedType: RuntimeType}[]};
export type WriteInput = PropertyTarget & {property: string; value: RuntimeValue};
export type AccessErrorCode = typeof errors[number];
export type AccessReason = typeof reasons[number];
export type AccessError = {code: AccessErrorCode; message: string; source: 'sdk' | 'host' | 'worker' | 'native' | 'godotjs'; property?: string; index?: number};
export type Correlation = {requestId: string; accessSequence: number; run: WorkerRunIdentity; releaseId: string; path: string; expectedInstanceId: string};
export type PublicResult<T> = {ok: true; receipt: Correlation; result: T} | {ok: false; receipt?: Correlation; error: AccessError};
export type NativeResult<T> = {ok: true; result: T} | {ok: false; error: AccessError};
export type AccessMode = {status: 'supported' | 'candidate'} | {status: 'unsupported'; reason: typeof unsupportedReasons[number]};
export type Descriptor = {name: string; declaredType: {variantType: number; name: string}; type: RuntimeType | null;
  origin: 'native' | 'godotjs_export'; readAccess: AccessMode; writeAccess: AccessMode;
  readMayExecuteScript: boolean; writeMayExecuteScript: boolean; shadowedExport: boolean};
export type Frame = {process: string; physics: string; drawn: string};
export type ScanReason = typeof scanReasons[number];
export type Scan = {metadataEntriesVisited: number; inheritanceLevelsVisited: number; truncated: boolean; reasons: ScanReason[]};
export type NamedDescriptor = {name: string; status: 'found'; descriptor: Descriptor} | {name: string; status: 'absent'} |
  {name: string; status: 'unresolved'; reason: Exclude<ScanReason, 'item_limit'>};
export type DescribeResult = {frame: Frame; scan: Scan} & ({mode: 'enumerate'; properties: Descriptor[]} | {mode: 'names'; properties: NamedDescriptor[]});
export type WriteEvidence = {phase: 'unknown'; writeEntered: 'unknown'} |
  {phase: 'before_read'; writeEntered: false; frame: Frame; beforeValue?: RuntimeValue} |
  {phase: 'write' | 'readback'; writeEntered: true; frame: Frame; beforeValue: RuntimeValue};
export type WriteResult = {property: string; requestedValue: RuntimeValue} & (
  {outcome: 'applied' | 'not_applied'; phase: 'readback'; writeEntered: true; frame: Frame; beforeValue: RuntimeValue; comparisonValue: RuntimeValue; observedValue: RuntimeValue} |
  {outcome: 'not_written'; phase: 'before_read'; writeEntered: false; reason: AccessReason; frame: Frame; beforeValue?: RuntimeValue} |
  {outcome: 'unconfirmed'; reason: AccessReason; evidence: WriteEvidence});
export type ReadItem = {name: string; expectedType: RuntimeType} & (
  {status: 'value'; readEntered: true; value: RuntimeValue} |
  {status: 'unavailable'; readEntered: boolean; reason: AccessReason} |
  {status: 'not_attempted'; readEntered: false});
export type ReadResult = {outcome: 'completed'; frame: Frame; properties: ReadItem[]; stopReason?: AccessReason} |
  {outcome: 'unconfirmed'; reason: typeof interruptionReasons[number]; evidence: {phase: 'unknown'} | {phase: 'read'; frame: Frame; properties: ReadItem[]}};
type WithoutRun<T> = T extends unknown ? Omit<T, 'runId' | 'timeoutMs'> : never;
export type PropertyCommand = ({kind: 'describe'} & WithoutRun<DescribeInput>) | ({kind: 'read'} & WithoutRun<ReadInput>) | ({kind: 'write'} & WithoutRun<WriteInput>);
export type NativePropertyRequest = PropertyCommand & {outputBudgetBytes: number};
export type PropertyKind = PropertyCommand['kind'];
export type ResultByKind = {describe: DescribeResult; read: ReadResult; write: WriteResult};
export type PropertyResult<K extends PropertyKind = PropertyKind> = PublicResult<ResultByKind[K]>;
export type RuntimePropertiesState = {supported: boolean | null; ready: boolean; version?: 1;
  supportedExportTypes?: readonly RuntimeType[]; supportedNativeProperties?: readonly string[]};
export type PreparedRuntimeProperties<K extends PropertyKind = PropertyKind> = {runId: string; timeoutMs: number; command: Extract<PropertyCommand, {kind: K}>};

/** Inspect descriptors before accessing fields, including for cross-realm objects. */
export function propertyRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    if (Object.getPrototypeOf(prototype) !== null || typeof constructor !== 'function' ||
      Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value !== prototype ||
      Function.prototype.toString.call(constructor) !== objectConstructorSource) return false;
  }
  return Reflect.ownKeys(value).every(key => {const field = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && !!field && field.enumerable && 'value' in field;});
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function array(value: unknown, max: number, min = 0): value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return false;
  return Reflect.ownKeys(value).every(key => {
    if (key === 'length') return true;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) return false;
    return !!Object.getOwnPropertyDescriptor(value, key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!;
  }) && Array.from({length: value.length}, (_, index) => Object.hasOwn(value, index)).every(Boolean);
}
/** Own data only: never call an input array's inherited methods, iterator or toJSON. */
function propertyData(value: unknown, remaining = {items: 4096}, depth = 0): unknown {
  if (--remaining.items < 0 || depth > 8) throw Error('E_RUNTIME_PROPERTIES_DATA');
  if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 64 || Reflect.ownKeys(value).length !== length + 1)
      throw Error('E_RUNTIME_PROPERTIES_ARRAY');
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (!item || !('value' in item)) throw Error('E_RUNTIME_PROPERTIES_ARRAY');
      result.push(propertyData(item.value, remaining, depth + 1));
    }
    return result;
  }
  if (!propertyRecord(value)) throw Error('E_RUNTIME_PROPERTIES_RECORD');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) result[key] = propertyData(Object.getOwnPropertyDescriptor(value, key)!.value, remaining, depth + 1);
  return result;
}
export function snapshotRuntimePropertyData(value: unknown): unknown {return propertyData(value);}
export function validRuntimeString(value: unknown, maxBytes = MAX_RUNTIME_PROPERTY_STRING_BYTES, allowNul = true): value is string {
  if (typeof value !== 'string' || value.length > maxBytes || !allowNul && value.includes('\0')) return false;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false;}
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return encoder.encode(value).byteLength <= maxBytes;
}
export const validPropertyName = (value: unknown): value is string => validRuntimeString(value, 256, false) && value.length > 0;
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const uint64 = (value: unknown, positive = false): value is string => typeof value === 'string' &&
  (positive ? /^[1-9][0-9]{0,19}$/ : /^(0|[1-9][0-9]{0,19})$/).test(value) &&
  (value.length < 20 || value <= '18446744073709551615');
const runtimeType = (value: unknown): value is RuntimeType => runtimeTypes.includes(value as RuntimeType);
const reason = (value: unknown): value is AccessReason => reasons.includes(value as AccessReason);
function bytes(value: unknown, max: number): boolean {return encoder.encode(JSON.stringify(value)).byteLength <= max;}
function owned<T>(value: T): T {return JSON.parse(JSON.stringify(value)) as T;}

export function readRuntimeValue(value: unknown): RuntimeValue | undefined {
  try {
    if (!propertyRecord(value) || !keys(value, ['type', 'value'])) return;
    switch (value.type) {
      case 'bool': if (typeof value.value === 'boolean') return {type: 'bool', value: value.value}; break;
      case 'int': if (typeof value.value === 'number' && Number.isSafeInteger(value.value)) return {type: 'int', value: value.value}; break;
      case 'float': if (typeof value.value === 'number' && Number.isFinite(value.value)) return {type: 'float', value: value.value}; break;
      case 'string': if (validRuntimeString(value.value)) return {type: 'string', value: value.value}; break;
      case 'vector2': {
        const coordinates = value.value;
        if (propertyRecord(coordinates) && keys(coordinates, ['x', 'y']) && typeof coordinates.x === 'number' && Number.isFinite(coordinates.x) &&
          typeof coordinates.y === 'number' && Number.isFinite(coordinates.y)) return {type: 'vector2', value: {x: coordinates.x, y: coordinates.y}};
      }
    }
  } catch { /* Untrusted values need not be serializable. */ }
}
export function readPropertyCommand(value: unknown): PropertyCommand | undefined {
  try {
    value = snapshotRuntimePropertyData(value);
    if (!propertyRecord(value) || !pathIsCanonical(value.path) || !uint64(value.expectedInstanceId, true)) return;
    const target = {path: value.path, expectedInstanceId: value.expectedInstanceId};
    let command: PropertyCommand | undefined;
    if (value.kind === 'describe' && keys(value, ['kind', 'path', 'expectedInstanceId'], ['names', 'limit'])) {
      if (value.names !== undefined) {
        if (value.limit !== undefined || !array(value.names, 16, 1) || !value.names.every(validPropertyName) || new Set(value.names).size !== value.names.length) return;
        command = {kind: 'describe', ...target, names: [...value.names] as string[]};
      } else {
        if (value.limit !== undefined && !integer(value.limit, 1, 64)) return;
        command = {kind: 'describe', ...target, limit: (value.limit ?? 32) as number};
      }
    } else if (value.kind === 'read' && keys(value, ['kind', 'path', 'expectedInstanceId', 'properties'])) {
      if (!array(value.properties, 16, 1)) return;
      const properties: {name: string; expectedType: RuntimeType}[] = [];
      for (const item of value.properties) {
        if (!propertyRecord(item) || !keys(item, ['name', 'expectedType']) || !validPropertyName(item.name) || !runtimeType(item.expectedType) || properties.some(prior => prior.name === item.name)) return;
        properties.push({name: item.name, expectedType: item.expectedType});
      }
      command = {kind: 'read', ...target, properties};
    } else if (value.kind === 'write' && keys(value, ['kind', 'path', 'expectedInstanceId', 'property', 'value']) && validPropertyName(value.property)) {
      const typed = readRuntimeValue(value.value);
      if (typed) command = {kind: 'write', ...target, property: value.property, value: typed};
    }
    if (command && bytes({...command, outputBudgetBytes: MAX_RUNTIME_PROPERTIES_RESULT_BYTES}, MAX_RUNTIME_REQUEST_BYTES)) return command;
  } catch { /* Reject hostile shapes. */ }
}
export function runtimePropertiesError(code: AccessErrorCode, source: AccessError['source'] = 'sdk', message: string = code): {ok: false; error: AccessError} {
  return {ok: false, error: {code, message: validRuntimeString(message, 512) ? message : code, source}};
}
export function prepareRuntimeProperties<K extends PropertyKind>(kind: K, input: unknown, signal?: AbortSignal):
  {ok: true; result: PreparedRuntimeProperties<K>} | {ok: false; error: AccessError} {
  try {
    if (!propertyRecord(input)) return runtimePropertiesError('invalid_input');
    const {runId, timeoutMs = 5000, ...raw} = input;
    if (!validInteractionId(runId) || !integer(timeoutMs, 1, MAX_OBSERVATION_TIMEOUT_MS) || Object.hasOwn(raw, 'kind')) return runtimePropertiesError('invalid_input');
    const command = readPropertyCommand({kind, ...raw});
    if (!command || command.kind !== kind) return runtimePropertiesError('invalid_input');
    if (signal !== undefined && readAborted.call(signal)) return runtimePropertiesError('cancelled');
    return {ok: true, result: {runId, timeoutMs, command: command as Extract<PropertyCommand, {kind: K}>}};
  } catch {return runtimePropertiesError('invalid_input');}
}

function frame(value: unknown): value is Frame {
  return propertyRecord(value) && keys(value, ['process', 'physics', 'drawn']) && uint64(value.process) && uint64(value.physics) && uint64(value.drawn);
}
function accessMode(value: unknown): value is AccessMode {
  return propertyRecord(value) && (value.status === 'supported' || value.status === 'candidate' ? keys(value, ['status']) :
    value.status === 'unsupported' && keys(value, ['status', 'reason']) && unsupportedReasons.includes(value.reason as typeof unsupportedReasons[number]));
}
function descriptor(value: unknown): value is Descriptor {
  if (!propertyRecord(value) || !keys(value, ['name', 'declaredType', 'type', 'origin', 'readAccess', 'writeAccess', 'readMayExecuteScript', 'writeMayExecuteScript', 'shadowedExport']) ||
    !validPropertyName(value.name) || !propertyRecord(value.declaredType) || !keys(value.declaredType, ['variantType', 'name']) ||
    !integer(value.declaredType.variantType, 0, 255) || !validRuntimeString(value.declaredType.name, 128, false) ||
    value.type !== null && !runtimeType(value.type) || !['native', 'godotjs_export'].includes(value.origin as string) ||
    !accessMode(value.readAccess) || !accessMode(value.writeAccess) || typeof value.readMayExecuteScript !== 'boolean' ||
    typeof value.writeMayExecuteScript !== 'boolean' || typeof value.shadowedExport !== 'boolean') return false;
  const mapped = ({1: 'bool', 2: 'int', 3: 'float', 4: 'string', 5: 'vector2'} as Record<number, RuntimeType>)[value.declaredType.variantType] ?? null;
  if (value.type !== mapped) return false;
  if (value.origin === 'godotjs_export' && value.type === 'vector2') {
    for (const mode of [value.readAccess, value.writeAccess]) if (mode.status !== 'unsupported' || mode.reason !== 'unsupported_export_type') return false;
  }
  return true;
}
function scan(value: unknown): value is Scan {
  return propertyRecord(value) && keys(value, ['metadataEntriesVisited', 'inheritanceLevelsVisited', 'truncated', 'reasons']) &&
    integer(value.metadataEntriesVisited, 0, 512) && integer(value.inheritanceLevelsVisited, 0, 16) && typeof value.truncated === 'boolean' &&
    array(value.reasons, 4) && value.reasons.every(item => scanReasons.includes(item as ScanReason)) && new Set(value.reasons).size === value.reasons.length &&
    value.truncated === (value.reasons.length > 0);
}
function compareNames(left: string, right: string): number {
  const a = Array.from(left), b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}
function sortedNames(items: {name: string}[]): boolean {return items.every((item, index) => !index || compareNames(items[index - 1]!.name, item.name) < 0);}
function describeResult(value: unknown, command?: Extract<PropertyCommand, {kind: 'describe'}>): value is DescribeResult {
  if (!propertyRecord(value) || !keys(value, ['frame', 'scan', 'mode', 'properties']) || !frame(value.frame) || !scan(value.scan) || !array(value.properties, 64)) return false;
  if (value.mode === 'enumerate') return (!command || !command.names && value.properties.length <= (command.limit ?? 32)) && value.properties.every(descriptor) && sortedNames(value.properties as Descriptor[]);
  if (value.mode !== 'names' || !array(value.properties, 16, 1) || command && !command.names) return false;
  const names: {name: string}[] = [];
  for (const item of value.properties) {
    if (!propertyRecord(item) || !validPropertyName(item.name)) return false;
    if (item.status === 'found') {if (!keys(item, ['name', 'status', 'descriptor']) || !descriptor(item.descriptor) || item.descriptor.name !== item.name) return false;}
    else if (item.status === 'absent') {if (!keys(item, ['name', 'status'])) return false;}
    else if (item.status === 'unresolved') {if (!keys(item, ['name', 'status', 'reason']) || !['metadata_limit', 'inheritance_limit', 'output_budget'].includes(item.reason as string)) return false;}
    else return false;
    names.push({name: item.name});
  }
  return sortedNames(names) && (!command?.names || names.length === command.names.length && names.every(item => command.names!.includes(item.name)));
}
function readItems(value: unknown, command?: Extract<PropertyCommand, {kind: 'read'}>, partial = false): value is ReadItem[] {
  if (!array(value, 16) || command && (partial ? value.length > command.properties.length : value.length !== command.properties.length)) return false;
  let stopped = false;
  for (const [index, item] of value.entries()) {
    if (!propertyRecord(item) || !validPropertyName(item.name) || !runtimeType(item.expectedType) ||
      command && (item.name !== command.properties[index]?.name || item.expectedType !== command.properties[index]?.expectedType)) return false;
    if (item.status === 'value') {
      const typed = readRuntimeValue(item.value);
      if (stopped || !keys(item, ['name', 'expectedType', 'status', 'readEntered', 'value']) || item.readEntered !== true || !typed || typed.type !== item.expectedType) return false;
    } else if (item.status === 'unavailable') {
      if (stopped || !keys(item, ['name', 'expectedType', 'status', 'readEntered', 'reason']) || typeof item.readEntered !== 'boolean' || !reason(item.reason)) return false;
      stopped = true;
    } else if (item.status === 'not_attempted') {
      if (!keys(item, ['name', 'expectedType', 'status', 'readEntered']) || item.readEntered !== false) return false;
      stopped = true;
    } else return false;
  }
  return new Set(value.map(item => (item as ReadItem).name)).size === value.length;
}
function readResult(value: unknown, command?: Extract<PropertyCommand, {kind: 'read'}>): value is ReadResult {
  if (!propertyRecord(value)) return false;
  if (value.outcome === 'completed') {
    if (!keys(value, ['outcome', 'frame', 'properties'], ['stopReason']) || !frame(value.frame) || !readItems(value.properties, command)) return false;
    const unavailable = value.properties.find(item => item.status === 'unavailable');
    return unavailable ? value.stopReason === unavailable.reason : value.properties.every(item => item.status === 'value') && value.stopReason === undefined;
  }
  if (value.outcome !== 'unconfirmed' || !keys(value, ['outcome', 'reason', 'evidence']) || !interruptionReasons.includes(value.reason as typeof interruptionReasons[number]) || !propertyRecord(value.evidence)) return false;
  return value.evidence.phase === 'unknown' ? keys(value.evidence, ['phase']) : value.evidence.phase === 'read' &&
    keys(value.evidence, ['phase', 'frame', 'properties']) && frame(value.evidence.frame) && readItems(value.evidence.properties, command, true) &&
    value.evidence.properties.some(item => item.readEntered);
}
function valueOfType(value: unknown, type: RuntimeType): boolean {return readRuntimeValue(value)?.type === type;}
function writeEvidence(value: unknown, type: RuntimeType): value is WriteEvidence {
  if (!propertyRecord(value)) return false;
  if (value.phase === 'unknown') return keys(value, ['phase', 'writeEntered']) && value.writeEntered === 'unknown';
  if (!frame(value.frame)) return false;
  if (value.phase === 'before_read') return keys(value, ['phase', 'writeEntered', 'frame'], ['beforeValue']) && value.writeEntered === false &&
    (value.beforeValue === undefined || valueOfType(value.beforeValue, type));
  return ['write', 'readback'].includes(value.phase as string) && keys(value, ['phase', 'writeEntered', 'frame', 'beforeValue']) && value.writeEntered === true && valueOfType(value.beforeValue, type);
}
function equalValue(left: RuntimeValue, right: RuntimeValue): boolean {return JSON.stringify(left) === JSON.stringify(right);}
function comparisonMatches(requested: RuntimeValue, comparison: RuntimeValue): boolean {
  if (equalValue(requested, comparison)) return true;
  // Godot real_t is float32 or float64; scalar floats always remain doubles.
  return requested.type === 'vector2' && comparison.type === 'vector2' &&
    equalValue(comparison, {type: 'vector2', value: {x: Math.fround(requested.value.x), y: Math.fround(requested.value.y)}});
}
function writeResult(value: unknown, command?: Extract<PropertyCommand, {kind: 'write'}>): value is WriteResult {
  if (!propertyRecord(value) || !validPropertyName(value.property)) return false;
  const requested = readRuntimeValue(value.requestedValue);
  if (!requested || command && (value.property !== command.property || !equalValue(requested, command.value))) return false;
  if (value.outcome === 'unconfirmed') return keys(value, ['property', 'requestedValue', 'outcome', 'reason', 'evidence']) && reason(value.reason) && writeEvidence(value.evidence, requested.type);
  if (value.outcome === 'not_written') return keys(value, ['property', 'requestedValue', 'outcome', 'phase', 'writeEntered', 'reason', 'frame'], ['beforeValue']) &&
    value.phase === 'before_read' && value.writeEntered === false && reason(value.reason) && frame(value.frame) && (value.beforeValue === undefined || valueOfType(value.beforeValue, requested.type));
  if (!['applied', 'not_applied'].includes(value.outcome as string) || !keys(value, ['property', 'requestedValue', 'outcome', 'phase', 'writeEntered', 'frame', 'beforeValue', 'comparisonValue', 'observedValue']) ||
    value.phase !== 'readback' || value.writeEntered !== true || !frame(value.frame)) return false;
  const before = readRuntimeValue(value.beforeValue), comparison = readRuntimeValue(value.comparisonValue), observed = readRuntimeValue(value.observedValue);
  return !!before && !!comparison && !!observed && before.type === requested.type && comparison.type === requested.type && observed.type === requested.type &&
    comparisonMatches(requested, comparison) && (value.outcome === 'applied') === equalValue(comparison, observed);
}
function accessError(value: unknown): value is AccessError {
  return propertyRecord(value) && keys(value, ['code', 'message', 'source'], ['property', 'index']) && errors.includes(value.code as AccessErrorCode) &&
    validRuntimeString(value.message, 512) && ['sdk', 'host', 'worker', 'native', 'godotjs'].includes(value.source as string) &&
    (value.property === undefined || validPropertyName(value.property)) && (value.index === undefined || integer(value.index, 0, 15));
}
export function readNativePropertyResult<K extends PropertyKind>(commandOrKind: K | Extract<PropertyCommand, {kind: K}>, value: unknown): NativeResult<ResultByKind[K]> | undefined {
  try {
    value = snapshotRuntimePropertyData(value);
    if (!propertyRecord(value) || !keys(value, ['ok'], value.ok === true ? ['result'] : ['error'])) return;
    if (value.ok === false && accessError(value.error)) {
      const reply = {ok: false as const, error: value.error};
      if (bytes(reply, MAX_RUNTIME_PROPERTIES_RESULT_BYTES)) return owned(reply);
      return;
    }
    if (value.ok !== true || !Object.hasOwn(value, 'result')) return;
    const kind = typeof commandOrKind === 'string' ? commandOrKind : commandOrKind.kind;
    const command = typeof commandOrKind === 'string' ? undefined : commandOrKind;
    const valid = kind === 'describe' ? describeResult(value.result, command as Extract<PropertyCommand, {kind: 'describe'}> | undefined) :
      kind === 'read' ? readResult(value.result, command as Extract<PropertyCommand, {kind: 'read'}> | undefined) :
      kind === 'write' && writeResult(value.result, command as Extract<PropertyCommand, {kind: 'write'}> | undefined);
    // Validate nested descriptors before JSON measurement: stringify itself may invoke getters.
    if (valid && bytes(value, MAX_RUNTIME_PROPERTIES_RESULT_BYTES)) return owned(value) as NativeResult<ResultByKind[K]>;
  } catch { /* Never expose an unvalidated native payload. */ }
}
export function runtimePropertiesUnconfirmed<K extends PropertyKind>(kind: K, why: AccessReason,
  command?: Extract<PropertyCommand, {kind: K}>): NativeResult<ResultByKind[K]> {
  if (kind === 'describe') return runtimePropertiesError(interruptionReasons.includes(why as typeof interruptionReasons[number]) && why !== 'transport_lost' ? why as AccessErrorCode : 'dispatch_failed', 'worker');
  if (kind === 'read') return {ok: true, result: {outcome: 'unconfirmed', reason: interruptionReasons.includes(why as typeof interruptionReasons[number]) ? why : 'transport_lost', evidence: {phase: 'unknown'}}} as NativeResult<ResultByKind[K]>;
  const write = command as Extract<PropertyCommand, {kind: 'write'}> | undefined;
  if (!write) throw Error('E_RUNTIME_PROPERTIES_COMMAND');
  return {ok: true, result: {property: write.property, requestedValue: owned(write.value), outcome: 'unconfirmed', reason: why,
    evidence: {phase: 'unknown', writeEntered: 'unknown'}}} as NativeResult<ResultByKind[K]>;
}
export function supportsWorkerRuntimeProperties(release: Pick<VerifiedRelease, 'runtimeAbi'>, presentation: WorkerRunConfiguration['presentationBackend']): boolean {
  return (release.runtimeAbi as {runtimeProperties?: number} | undefined)?.runtimeProperties === RUNTIME_PROPERTIES_VERSION && presentation === 'direct';
}
export interface NativePropertiesModule extends NativeObservationModule {
  _godotjs_runtime_properties_abi?: () => number;
  _godotjs_runtime_properties_execute?: (bytes: number, remainingBudgetMicros: number) => number;
}
export function createNativeRuntimeProperties(module: NativePropertiesModule) {
  const abi = module._godotjs_runtime_properties_abi, execute = module._godotjs_runtime_properties_execute;
  const buffer = module._godotjs_runtime_observation_buffer;
  if (typeof abi !== 'function' || abi() !== RUNTIME_PROPERTIES_VERSION || typeof execute !== 'function' || typeof buffer !== 'function') throw Error('E_RUNTIME_PROPERTIES_ABI');
  function memory(pointer: number, size: number) {
    const heap = module.HEAPU8;
    if (!(heap instanceof Uint8Array) || !integer(pointer, 1, Number.MAX_SAFE_INTEGER) || size > heap.byteLength - pointer) throw Error('E_RUNTIME_PROPERTIES_BUFFER');
    return heap.subarray(pointer, pointer + size);
  }
  memory(buffer(), MAX_RUNTIME_PROPERTIES_RESULT_BYTES);
  return <K extends PropertyKind>(command: Extract<PropertyCommand, {kind: K}>, deadline: number,
    outputBudgetBytes = MAX_RUNTIME_PROPERTIES_RESULT_BYTES): NativeResult<ResultByKind[K]> => {
    let entered = false;
    try {
      if (!integer(outputBudgetBytes, 1024, MAX_RUNTIME_PROPERTIES_RESULT_BYTES)) return runtimePropertiesError('invalid_input', 'worker');
      const input = encoder.encode(JSON.stringify({...command, outputBudgetBytes}));
      if (input.byteLength > MAX_RUNTIME_REQUEST_BYTES) return runtimePropertiesError('invalid_input', 'worker');
      const pointer = buffer();
      memory(pointer, input.byteLength).set(input);
      const budget = Math.floor((deadline - interactionNow()) * 1000);
      if (budget <= 0) return runtimePropertiesError('timeout', 'worker');
      entered = true;
      const length = execute(input.byteLength, Math.min(budget, 30_000_000));
      if (!integer(length, 1, outputBudgetBytes)) throw Error('E_RUNTIME_PROPERTIES_RESULT');
      const result = readNativePropertyResult(command, JSON.parse(decoder.decode(memory(pointer, length))));
      if (!result) throw Error('E_RUNTIME_PROPERTIES_RESULT');
      return result;
    } catch {
      if (!entered || command.kind === 'describe') return runtimePropertiesError('dispatch_failed', 'worker');
      return runtimePropertiesUnconfirmed<PropertyKind>(command.kind, 'readback_failed', command) as NativeResult<ResultByKind[K]>;
    }
  };
}

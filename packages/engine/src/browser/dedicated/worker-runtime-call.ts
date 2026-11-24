import type {VerifiedRelease} from '../verified-loader.js';
import type {WorkerRunConfiguration} from './worker-protocol.js';
import {interactionNow, validInteractionId} from './worker-interaction.js';
import {createNativeRuntimeRequest, MAX_OBSERVATION_TIMEOUT_MS, MAX_RUNTIME_REQUEST_BYTES, type NativeObservationModule} from './worker-runtime-observation.js';
import {isRuntimeFrame, pathIsCanonical, propertyRecord, readRuntimeValue, snapshotRuntimePropertyData,
  validPropertyName, validRuntimeUint64, type AccessError, type AccessErrorCode, type Correlation, type Frame, type PropertyTarget, type RuntimeValue} from './worker-runtime-properties.js';

export const RUNTIME_CALL_VERSION = 1;
const RESULT_BYTES = 65_536;
const encoder = new TextEncoder();
const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const scalarTypes = ['bool', 'int', 'float', 'string'] as const;
const failureCodes = ['invalid_input', 'unsupported', 'not_found', 'run_ended', 'not_ready', 'busy', 'node_not_found', 'node_changed',
  'dispatch_failed', 'timeout', 'cancelled', 'bad_args', 'method_not_found', 'binding_changed', 'output_budget'] as const;
const unavailableReasons = ['type_mismatch', 'value_too_large', 'output_budget', 'encoding_failed'] as const;
const uncertainReasons = ['timeout', 'cancelled', 'run_ended', 'transport_lost'] as const;

export type RuntimeMethodScalar = Exclude<RuntimeValue, {type: 'vector2'}>;
export type RuntimeMethodType = RuntimeMethodScalar['type'] | 'void';
export type RuntimeMethodToken = Readonly<{version: 1; runId: string; releaseId: string; returnType: RuntimeMethodType; stamp: string}>;
export type RuntimeMethodTarget = PropertyTarget;
export type DescribeMethodsInput = RuntimeMethodTarget & ({method?: never; limit?: number} | {method: string; limit?: never});
export type CallMethodInput = RuntimeMethodTarget & {method: string; methodToken: RuntimeMethodToken; args: readonly RuntimeMethodScalar[]};
type NativeMethodTarget = Omit<RuntimeMethodTarget, 'runId' | 'timeoutMs'>;
export type DescribeMethodsCommand = NativeMethodTarget & ({kind: 'describe'; method?: never; limit?: number} | {kind: 'describe'; method: string; limit?: never});
export type CallMethodCommand = NativeMethodTarget & {kind: 'invoke'; method: string; methodStamp: string; expectedReturnType: RuntimeMethodType; args: readonly RuntimeMethodScalar[]};
export type MethodCommand = DescribeMethodsCommand | CallMethodCommand;
export type MethodKind = MethodCommand['kind'];
type NativeMethodDescriptor = {method: string; parameterTypes: RuntimeMethodScalar['type'][]; returnType: RuntimeMethodType; methodStamp: string};
export type RuntimeMethodDescriptor = Omit<NativeMethodDescriptor, 'methodStamp'> & {methodToken: RuntimeMethodToken};
type NativeDescription = {methods: NativeMethodDescriptor[]; truncated: boolean};
export type MethodDescription = {methods: RuntimeMethodDescriptor[]; truncated: boolean};
export type MethodUncertainReason = typeof uncertainReasons[number];
export type MethodOutcome =
  | {outcome: 'returned'; callEntered: true; entryFrame: Frame; value: RuntimeMethodScalar | {type: 'void'}}
  | {outcome: 'threw'; callEntered: true; entryFrame: Frame}
  | {outcome: 'result_unavailable'; callEntered: true; entryFrame: Frame; reason: typeof unavailableReasons[number]}
  | {outcome: 'unconfirmed'; callEntered: 'unknown'; reason: MethodUncertainReason};
export type MethodReceipt = Correlation & {method?: string};
export type MethodErrorCode = typeof failureCodes[number];
export type MethodError = {code: MethodErrorCode; message: string; source: AccessError['source']};
export type MethodFailure = {ok: false; error: MethodError; receipt?: MethodReceipt};
export type MethodDescriptionResult = {ok: true; receipt: MethodReceipt; result: MethodDescription} | MethodFailure;
export type MethodCallResult = {ok: true; receipt: MethodReceipt; result: MethodOutcome} | MethodFailure;
export type NativeMethodResult = {ok: true; result: NativeDescription | MethodOutcome} | MethodFailure;
export type RuntimeCallState = {supported: boolean | null; ready: boolean; version?: 1};
export type PreparedMethod = {runId: string; deadline: number; command: MethodCommand};

const stampPattern = /^[a-f0-9]{64}$/;
const validStamp = (value: unknown): value is string => typeof value === 'string' && stampPattern.test(value);
const scalarType = (value: unknown): value is RuntimeMethodScalar['type'] => scalarTypes.includes(value as RuntimeMethodScalar['type']);
const resultType = (value: unknown): value is RuntimeMethodType => value === 'void' || scalarType(value);
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function encodeMethodRequest(command: MethodCommand, runScope: string, outputBudgetBytes: number): Uint8Array {
  if (command.kind === 'describe') return encoder.encode(JSON.stringify({...command, runScope, outputBudgetBytes}));
  const {args, ...target} = command;
  const envelope = JSON.stringify({...target, runScope, outputBudgetBytes});
  // JSON.stringify normalizes -0. Spell it explicitly for typed float arguments.
  const values = args.map(arg => arg.type === 'float' && Object.is(arg.value, -0) ? '{"type":"float","value":-0}' : JSON.stringify(arg));
  return encoder.encode(envelope.slice(0, -1) + ',"args":[' + values.join(',') + ']}');
}

export function runtimeMethodError(code: MethodErrorCode, source: MethodError['source'] = 'sdk', message: string = code): MethodFailure {
  return {ok: false, error: {code, message, source}};
}

export function uncertainMethod(command: MethodCommand, reason: MethodUncertainReason, source: MethodError['source']): NativeMethodResult {
  return command.kind === 'describe' ? runtimeMethodError(reason === 'transport_lost' ? 'dispatch_failed' : reason, source) :
    {ok: true, result: {outcome: 'unconfirmed', callEntered: 'unknown', reason}};
}

export function methodTransportError(code: AccessErrorCode, source: MethodError['source']): MethodFailure {
  return runtimeMethodError(failureCodes.includes(code as MethodErrorCode) ? code as MethodErrorCode : 'dispatch_failed', source);
}

export function readMethodCommand(value: unknown): MethodCommand | undefined {
  try {
    const raw = snapshotRuntimePropertyData(value);
    if (!propertyRecord(raw) || !pathIsCanonical(raw.path) || !validRuntimeUint64(raw.expectedInstanceId, true)) return;
    const target = {path: raw.path, expectedInstanceId: raw.expectedInstanceId};
    const common = ['kind', 'path', 'expectedInstanceId'];
    if (raw.kind === 'describe' && keys(raw, common, ['method', 'limit'])) {
      if (Object.hasOwn(raw, 'method')) {
        if (Object.hasOwn(raw, 'limit') || !validPropertyName(raw.method)) return;
        return {kind: 'describe', ...target, method: raw.method};
      }
      const limit = raw.limit === undefined ? 32 : raw.limit;
      if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 64)
        return {kind: 'describe', ...target, limit};
    } else if (raw.kind === 'invoke' &&
        keys(raw, [...common, 'method', 'methodStamp', 'expectedReturnType', 'args']) &&
        validPropertyName(raw.method) && validStamp(raw.methodStamp) && resultType(raw.expectedReturnType) &&
        Array.isArray(raw.args) && raw.args.length <= 8) {
      const args: RuntimeMethodScalar[] = [];
      for (const item of raw.args) {
        const scalar = readRuntimeValue(item);
        if (!scalar || scalar.type === 'vector2') return;
        args.push(scalar);
      }
      return {kind: 'invoke', ...target, method: raw.method, methodStamp: raw.methodStamp, expectedReturnType: raw.expectedReturnType, args};
    }
  } catch { /* Only bounded plain data is accepted. */ }
}

function readToken(value: unknown): RuntimeMethodToken | undefined {
  if (!propertyRecord(value) || !keys(value, ['version', 'runId', 'releaseId', 'returnType', 'stamp']) ||
      value.version !== 1 || !validInteractionId(value.runId) || typeof value.releaseId !== 'string' || !value.releaseId ||
      !validStamp(value.stamp) || !resultType(value.returnType)) return;
  return {version: 1, runId: value.runId, releaseId: value.releaseId, stamp: value.stamp, returnType: value.returnType};
}

export function prepareRuntimeMethod(kind: MethodKind, input: unknown, releaseId: string, signal?: AbortSignal, absoluteDeadline?: number):
  {ok: true; result: PreparedMethod} | MethodFailure {
  const now = interactionNow();
  try {
    const raw = snapshotRuntimePropertyData(input);
    if (!propertyRecord(raw)) return runtimeMethodError('invalid_input');
    const {runId, timeoutMs = 5000, ...fields} = raw;
    if (!validInteractionId(runId) || typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 || timeoutMs > MAX_OBSERVATION_TIMEOUT_MS || Object.hasOwn(fields, 'kind')) return runtimeMethodError('invalid_input');
    const deadline = absoluteDeadline ?? now + timeoutMs;
    if (!Number.isFinite(deadline) || deadline > now + MAX_OBSERVATION_TIMEOUT_MS) return runtimeMethodError('invalid_input');
    if (deadline <= now) return runtimeMethodError('timeout');
    if (signal !== undefined && readAborted.call(signal)) return runtimeMethodError('cancelled');
    let command: MethodCommand | undefined;
    if (kind === 'invoke') {
      const {methodToken, ...methodFields} = fields;
      if (!keys(methodFields, ['path', 'expectedInstanceId', 'method', 'args']) || !Array.isArray(methodFields.args))
        return runtimeMethodError('invalid_input');
      const token = readToken(methodToken);
      if (!token) return runtimeMethodError('invalid_input');
      if (token.runId !== runId || token.releaseId !== releaseId) return runtimeMethodError('binding_changed');
      command = readMethodCommand({kind, ...methodFields, methodStamp: token.stamp, expectedReturnType: token.returnType});
      if (!command && validPropertyName(methodFields.method) && pathIsCanonical(methodFields.path) &&
          validRuntimeUint64(methodFields.expectedInstanceId, true)) return runtimeMethodError('bad_args');
    } else {
      command = readMethodCommand({kind, ...fields});
    }
    if (!command) return runtimeMethodError('invalid_input');
    // Reserve the full native envelope, including the largest output budget.
    if (encodeMethodRequest(command, JSON.stringify([runId, releaseId]), RESULT_BYTES).byteLength > MAX_RUNTIME_REQUEST_BYTES)
      return runtimeMethodError(kind === 'invoke' ? 'bad_args' : 'invalid_input');
    return {ok: true, result: {runId, deadline, command}};
  } catch {return runtimeMethodError('invalid_input');}
}

function readDescription(command: DescribeMethodsCommand, body: Record<string, unknown>): NativeDescription | undefined {
  if (!keys(body, ['methods', 'truncated']) || typeof body.truncated !== 'boolean' || !Array.isArray(body.methods) ||
      body.methods.length > (command.limit ?? (command.method ? 1 : 32))) return;
  if (command.method && (body.methods.length !== 1 || body.truncated)) return;
  const methods: NativeMethodDescriptor[] = [];
  const seen = new Set<string>();
  for (const method of body.methods) {
    if (!propertyRecord(method) || !keys(method, ['method', 'parameterTypes', 'returnType', 'methodStamp']) ||
        !validPropertyName(method.method) || seen.has(method.method) ||
        command.method && method.method !== command.method || !Array.isArray(method.parameterTypes) ||
        method.parameterTypes.length > 8 || !method.parameterTypes.every(scalarType) ||
        !resultType(method.returnType) || !validStamp(method.methodStamp)) return;
    seen.add(method.method);
    methods.push({method: method.method, parameterTypes: method.parameterTypes, returnType: method.returnType, methodStamp: method.methodStamp});
  }
  return {methods, truncated: body.truncated};
}

export function readNativeMethodResult(command: MethodCommand, value: unknown, allowUnknown = false): NativeMethodResult | undefined {
  try {
    if (!propertyRecord(value) || (value.ok !== true && value.ok !== false)) return;
    const raw = snapshotRuntimePropertyData(value) as Record<string, unknown>;
    if (raw.ok === false) {
      if (!keys(raw, ['ok', 'error']) || !propertyRecord(raw.error) || !keys(raw.error, ['code', 'source', 'message'])) return;
      const {code, source, message} = raw.error;
      if (!failureCodes.includes(code as MethodErrorCode) || !['native', 'worker', 'host', 'sdk', 'godotjs'].includes(source as string) ||
          typeof message !== 'string' || message.length > 256) return;
      return runtimeMethodError(code as MethodErrorCode, source as MethodError['source'], message);
    }
    if (!keys(raw, ['ok', 'result']) || !propertyRecord(raw.result)) return;
    const body = raw.result;
    if (command.kind === 'describe') {
      const result = readDescription(command, body);
      if (result) return {ok: true, result};
      return;
    }
    if (body.outcome === 'unconfirmed' && allowUnknown && keys(body, ['outcome', 'callEntered', 'reason']) &&
        body.callEntered === 'unknown' && uncertainReasons.includes(body.reason as MethodUncertainReason)) {
      return uncertainMethod(command, body.reason as MethodUncertainReason, 'worker');
    }
    if (body.callEntered !== true || !isRuntimeFrame(body.entryFrame)) return;
    const common = {callEntered: true as const, entryFrame: {...body.entryFrame}};
    const base = ['outcome', 'callEntered', 'entryFrame'];
    if (body.outcome === 'threw' && keys(body, base)) return {ok: true, result: {outcome: 'threw', ...common}};
    if (body.outcome === 'result_unavailable' && keys(body, [...base, 'reason']) &&
        unavailableReasons.includes(body.reason as typeof unavailableReasons[number])) {
      return {ok: true, result: {outcome: 'result_unavailable', ...common, reason: body.reason as typeof unavailableReasons[number]}};
    }
    if (body.outcome === 'returned' && keys(body, [...base, 'value'])) {
      if (command.expectedReturnType === 'void') {
        if (propertyRecord(body.value) && keys(body.value, ['type']) && body.value.type === 'void')
          return {ok: true, result: {outcome: 'returned', ...common, value: {type: 'void'}}};
      } else {
        const scalar = readRuntimeValue(body.value);
        if (scalar && scalar.type === command.expectedReturnType) return {ok: true, result: {outcome: 'returned', ...common, value: scalar}};
      }
    }
  } catch { /* Malformed replies are not execution evidence. */ }
}

export function publicMethodResult(response: NativeMethodResult, receipt: MethodReceipt): MethodDescriptionResult | MethodCallResult {
  if (!response.ok) return {...response, receipt};
  if ('outcome' in response.result) return {ok: true, receipt, result: response.result};
  const methods = response.result.methods.map(({methodStamp, ...descriptor}) => ({...descriptor,
    methodToken: {version: 1 as const, runId: receipt.run.runId, releaseId: receipt.releaseId, returnType: descriptor.returnType, stamp: methodStamp}}));
  return {ok: true, receipt, result: {methods, truncated: response.result.truncated}};
}

export function supportsWorkerRuntimeCall(release: Pick<VerifiedRelease, 'runtimeAbi'>, presentation: WorkerRunConfiguration['presentationBackend']): boolean {
  return release.runtimeAbi?.runtimeCall === RUNTIME_CALL_VERSION && presentation === 'direct';
}

export interface NativeRuntimeCallModule extends NativeObservationModule {
  _godotjs_runtime_call_abi?: () => number;
  _godotjs_runtime_call_execute?: (bytes: number, remainingBudgetMicros: number) => number;
}
export function createNativeRuntimeCall(module: NativeRuntimeCallModule) {
  const abi = module._godotjs_runtime_call_abi, execute = module._godotjs_runtime_call_execute;
  if (typeof abi !== 'function' || abi() !== RUNTIME_CALL_VERSION || typeof execute !== 'function') throw Error('E_RUNTIME_CALL_ABI');
  let budget = 0, resultLimit = RESULT_BYTES;
  const send = createNativeRuntimeRequest(module, size => {
    const bytes = execute(size, budget);
    if (bytes > resultLimit) throw Error('E_RUNTIME_CALL_RESULT');
    return bytes;
  });
  return (command: MethodCommand, deadline: number, runScope: string, outputBudgetBytes: number): NativeMethodResult => {
    let sent = false;
    try {
      resultLimit = outputBudgetBytes;
      const input = encodeMethodRequest(command, runScope, outputBudgetBytes);
      if (input.byteLength > MAX_RUNTIME_REQUEST_BYTES) return runtimeMethodError(command.kind === 'invoke' ? 'bad_args' : 'invalid_input', 'worker');
      const response = send(input, () => {
        budget = Math.min(30_000_000, Math.floor((deadline - interactionNow()) * 1000));
        return sent = budget > 0;
      });
      if (!sent) return runtimeMethodError('timeout', 'worker');
      return readNativeMethodResult(command, response) ?? uncertainMethod(command, 'transport_lost', 'worker');
    } catch {
      return sent ? uncertainMethod(command, 'transport_lost', 'worker') : runtimeMethodError('dispatch_failed', 'worker');
    }
  };
}

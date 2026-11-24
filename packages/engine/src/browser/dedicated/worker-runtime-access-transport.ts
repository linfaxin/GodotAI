import {interactionNow, validInteractionId} from './worker-interaction.js';
import {MAX_OBSERVATION_TIMEOUT_MS} from './worker-runtime-observation.js';
import {readRuntimeWriteCommand, readRuntimeWriteResult, runtimeWriteError, runtimeWriteUnconfirmed,
  type RuntimeWriteCommand, type RuntimeWriteResult, type RuntimeSetError} from './worker-runtime-write.js';
import {scheduleRuntimeWriteDeadline} from './worker-runtime-write-transport.js';
import {readPropertyCommand, readNativePropertyResult, runtimePropertiesError, runtimePropertiesUnconfirmed,
  type PropertyCommand, type PropertyKind, type NativeResult, type ResultByKind, type AccessErrorCode} from './worker-runtime-properties.js';

import {methodTransportError, readMethodCommand, readNativeMethodResult, uncertainMethod,
  type MethodCommand, type MethodKind, type NativeMethodResult} from './worker-runtime-call.js';

export type AccessFamily = 'write' | 'property' | 'method';
export interface AccessId {family: AccessFamily; requestId: string; sequence: number}
export type AccessCommand = RuntimeWriteCommand | PropertyCommand | MethodCommand;
export type AccessResult = RuntimeWriteResult | NativeResult<ResultByKind[PropertyKind]> | NativeMethodResult;
export interface AccessRequest extends AccessId {deadline: number; command: AccessCommand}
export interface AccessReply extends AccessId {kind?: PropertyKind | MethodKind; result: AccessResult}
export function readAccessId(family: AccessFamily, packet: {requestId?: unknown; writeSequence?: unknown; accessSequence?: unknown}, runId: string): AccessId | undefined {
  const sequence = family === 'write' ? packet.writeSequence : packet.accessSequence;
  return validInteractionId(packet.requestId) && typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0 &&
    packet.requestId === runId + ':' + sequence ? {family, requestId: packet.requestId, sequence} : undefined;
}
export const sameAccess = (left: AccessId | undefined, right: AccessId) => !!left &&
  left.family === right.family && left.sequence === right.sequence && left.requestId === right.requestId;
const kind = (request: AccessRequest): PropertyKind | MethodKind | undefined =>
  request.family === 'write' ? undefined : (request.command as PropertyCommand | MethodCommand).kind;
function rawKind(family: AccessFamily, packet: {command?: unknown}): PropertyKind | MethodKind | undefined {
  try {
    if (!packet.command || typeof packet.command !== 'object') return;
    const value = Object.getOwnPropertyDescriptor(packet.command, 'kind')?.value;
    const kinds = family === 'method' ? ['describe', 'invoke'] : family === 'property' ? ['describe', 'read', 'write'] : [];
    return kinds.includes(value) ? value : undefined;
  } catch { return; }
}
export function runtimeAccessFamily(type: unknown): AccessFamily | undefined {
  if (typeof type !== 'string' || !/^runtime-(write|property|method)-(request|cancel|result)$/.test(type)) return;
  return type.split('-')[1] as AccessFamily;
}
function readRequest(id: AccessId, packet: {deadline?: unknown; command?: unknown}): AccessRequest | undefined {
  const {deadline} = packet;
  if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline - interactionNow() > MAX_OBSERVATION_TIMEOUT_MS) return;
  const command = id.family === 'write' ? readRuntimeWriteCommand(packet.command) :
    id.family === 'method' ? readMethodCommand(packet.command) : readPropertyCommand(packet.command);
  return command ? {...id, deadline, command} : undefined;
}
function failure(family: AccessFamily, code: AccessErrorCode, source: 'host' | 'worker'): AccessResult {
  return family === 'write' ? runtimeWriteError(code as RuntimeSetError) :
    family === 'method' ? methodTransportError(code, source) : runtimePropertiesError(code, source);
}
function unknown(request: AccessRequest, reason: 'run_ended' | 'transport_lost'): AccessResult {
  if (request.family === 'method') return uncertainMethod(request.command as MethodCommand, reason, 'host');
  if (request.family === 'property' && (request.command as PropertyCommand).kind === 'describe')
    return runtimePropertiesError(reason === 'transport_lost' ? 'dispatch_failed' : reason, 'host');
  return request.family === 'write' ? runtimeWriteUnconfirmed(reason) :
    runtimePropertiesUnconfirmed((request.command as PropertyCommand).kind, reason, request.command as PropertyCommand);
}
function reply(request: AccessRequest, result: AccessResult): AccessReply {
  return {family: request.family, requestId: request.requestId, sequence: request.sequence,
    ...(kind(request) ? {kind: kind(request)} : {}), result};
}
function readResult(request: AccessRequest, value: unknown): AccessResult | undefined {
  if (request.family === 'method') return readNativeMethodResult(request.command as MethodCommand, value, true);
  return request.family === 'write' ? readRuntimeWriteResult(value) : readNativePropertyResult(request.command as PropertyCommand, value);
}
export function accessPacket(request: AccessRequest): object {
  return request.family === 'write' ? {type: 'runtime-write-request', requestId: request.requestId,
    writeSequence: request.sequence, deadline: request.deadline, command: request.command} :
    {type: 'runtime-' + request.family + '-request', requestId: request.requestId, accessSequence: request.sequence,
      deadline: request.deadline, command: request.command};
}
export function accessCancelPacket(id: AccessId): object {
  return {type: 'runtime-' + id.family + '-cancel', requestId: id.requestId,
    ...(id.family === 'write' ? {writeSequence: id.sequence} : {accessSequence: id.sequence})};
}
/** One owner for replay protection and pending execution across legacy writes and property access. */
export function createWorkerRuntimeAccess(execute: (request: AccessRequest) => AccessResult, send: (response: AccessReply) => void) {
  let highestSequence = 0;
  let pending: (AccessRequest & {cancelTimer(): void}) | undefined;
  function take() {const current = pending; pending = undefined; current?.cancelTimer(); return current;}
  function fail(code: AccessErrorCode) {const current = take(); if (current) send(reply(current, failure(current.family, code, 'worker')));}
  return {
    request(id: AccessId, packet: {deadline?: unknown; command?: unknown}, unavailable?: AccessErrorCode) {
      if (id.sequence <= highestSequence) return;
      highestSequence = id.sequence;
      if (pending && interactionNow() >= pending.deadline) fail('timeout');
      const request = readRequest(id, packet);
      const error = !request ? 'invalid_input' : unavailable ?? (request.deadline <= interactionNow() ? 'timeout' : pending ? 'busy' : undefined);
      if (!request || error) {
        send({...id, ...((request ? kind(request) : rawKind(id.family, packet)) ? {kind: request ? kind(request) : rawKind(id.family, packet)} : {}), result: failure(id.family, error ?? 'invalid_input', 'worker')});
        return;
      }
      pending = {...request, cancelTimer: scheduleRuntimeWriteDeadline(request.deadline, () => {if (sameAccess(pending, id)) fail('timeout');})};
    },
    execute() {
      const current = take(); if (!current) return;
      let result: AccessResult;
      try {result = interactionNow() >= current.deadline ? failure(current.family, 'timeout', 'worker') : execute(current);}
      catch {result = current.family === 'method' ? uncertainMethod(current.command as MethodCommand, 'transport_lost', 'worker') :
        current.family === 'write' ? runtimeWriteUnconfirmed('readback_failed') :
          runtimePropertiesUnconfirmed((current.command as PropertyCommand).kind, 'readback_failed', current.command as PropertyCommand);}
      send(reply(current, result));
    },
    cancel(id: AccessId) {if (sameAccess(pending, id)) fail('cancelled');},
    stop() {fail('run_ended');},
  };
}
/** iframe relay owns the authoritative logical slot and two separately owned physical deliveries. */
export function createRuntimeAccessRelay(forward: (packet: object) => number | undefined, send: (response: AccessReply) => void) {
  let highestSequence = 0;
  let pending: AccessRequest | undefined;
  let requestDelivery: {request: AccessRequest; dataSequence: number} | undefined;
  let cancelDelivery: {id: AccessId; dataSequence: number} | undefined;
  function expire() {if (pending && pending.deadline <= interactionNow() && !sameAccess(requestDelivery?.request, pending)) pending = undefined;}
  return {
    request(id: AccessId, packet: {deadline?: unknown; command?: unknown}, unavailable?: AccessErrorCode) {
      if (id.sequence <= highestSequence) return;
      highestSequence = id.sequence; expire();
      const request = readRequest(id, packet);
      const error = !request ? 'invalid_input' : unavailable ?? (request.deadline <= interactionNow() ? 'timeout' : pending || requestDelivery ? 'busy' : undefined);
      if (!request || error) {
        send({...id, ...((request ? kind(request) : rawKind(id.family, packet)) ? {kind: request ? kind(request) : rawKind(id.family, packet)} : {}), result: failure(id.family, error ?? 'invalid_input', 'host')}); return;
      }
      let sequence: number | undefined;
      try { sequence = forward(accessPacket(request)); }
      catch {send(reply(request, failure(id.family, 'dispatch_failed', 'host'))); return;}
      if (sequence === undefined) {send(reply(request, failure(id.family, 'busy', 'host'))); return;}
      requestDelivery = {request, dataSequence: sequence}; pending = request;
    },
    cancel(id: AccessId) {
      expire(); if (!sameAccess(pending, id) || cancelDelivery) return;
      try {const dataSequence = forward(accessCancelPacket(id)); if (dataSequence !== undefined) cancelDelivery = {id: {...id}, dataSequence};}
      catch { /* Original deadline remains authoritative. */ }
    },
    receipt(sequence: number) {
      if (requestDelivery?.dataSequence === sequence) requestDelivery = undefined;
      if (cancelDelivery?.dataSequence === sequence) cancelDelivery = undefined;
      expire();
    },
    reply(id: AccessId, value: unknown, responseKind?: unknown) {
      const current = sameAccess(pending, id) ? pending : sameAccess(requestDelivery?.request, id) ? requestDelivery!.request : undefined;
      if (!current || (id.family !== 'write' && responseKind !== kind(current))) return;
      const result = readResult(current, value); if (!result) return;
      if (sameAccess(requestDelivery?.request, id)) requestDelivery = undefined;
      if (!sameAccess(pending, id)) return;
      pending = undefined; send(reply(current, result));
    },
    stop() {const current = pending; pending = undefined; if (current) send(reply(current, unknown(current, 'run_ended')));},
    dispose() {pending = undefined; requestDelivery = undefined; cancelDelivery = undefined;},
  };
}

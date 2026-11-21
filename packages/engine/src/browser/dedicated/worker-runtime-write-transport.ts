import {interactionNow, validInteractionId} from './worker-interaction.js';
import {MAX_OBSERVATION_TIMEOUT_MS} from './worker-runtime-observation.js';
import {readRuntimeWriteCommand, readRuntimeWriteResult, runtimeWriteError, runtimeWriteUnconfirmed,
  type RuntimeSetError, type RuntimeWriteCommand, type RuntimeWriteResult} from './worker-runtime-write.js';

export type RuntimeWriteId = {requestId: string; writeSequence: number};
export type RuntimeWriteRequest = RuntimeWriteId & {deadline: number; command: RuntimeWriteCommand};
export type RuntimeWriteReply = RuntimeWriteId & {result: RuntimeWriteResult};
type WritePacket = ({type: 'runtime-write-request'} & RuntimeWriteRequest) |
  ({type: 'runtime-write-cancel'} & RuntimeWriteId);

export function readRuntimeWriteId(packet: {requestId?: unknown; writeSequence?: unknown}, runId: string):
  RuntimeWriteId | undefined {
  const {requestId, writeSequence} = packet;
  if (validInteractionId(requestId) && typeof writeSequence === 'number' && Number.isSafeInteger(writeSequence) &&
      writeSequence > 0 && requestId === runId + ':' + writeSequence) return {requestId, writeSequence};
}

export function sameRuntimeWrite(left: RuntimeWriteId | undefined, right: RuntimeWriteId): boolean {
  return left?.requestId === right.requestId && left.writeSequence === right.writeSequence;
}

export function scheduleRuntimeWriteDeadline(deadline: number, expire: () => void): () => void {
  const remainingMs = () => Math.ceil(deadline - interactionNow());
  // Timer delays may be quantized. Use the absolute clock to settle the write.
  const check = () => {
    const remaining = remainingMs();
    if (remaining > 0) timer = setTimeout(check, remaining);
    else expire();
  };
  let timer = setTimeout(check, Math.max(0, remainingMs()));
  return () => clearTimeout(timer);
}

function readRequest(id: RuntimeWriteId, packet: {deadline?: unknown; command?: unknown}): RuntimeWriteRequest | undefined {
  const {deadline} = packet;
  if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline - interactionNow() > MAX_OBSERVATION_TIMEOUT_MS) return;
  const command = readRuntimeWriteCommand(packet.command);
  if (command) return {...id, deadline, command};
}

type SendReply = (reply: RuntimeWriteReply) => void;
type PendingWrite = RuntimeWriteRequest & {cancelTimer: () => void};
export function createWorkerRuntimeWrites(
  execute: (command: RuntimeWriteCommand, deadline: number) => RuntimeWriteResult,
  send: SendReply,
) {
  let highestSequence = 0;
  let pending: PendingWrite | undefined;

  function takePending(): PendingWrite | undefined {
    const current = pending;
    pending = undefined;
    current?.cancelTimer();
    return current;
  }
  function failPending(code: RuntimeSetError): void {
    const current = takePending();
    if (current) send({requestId: current.requestId, writeSequence: current.writeSequence, result: runtimeWriteError(code)});
  }
  return {
    request(id: RuntimeWriteId, packet: {deadline?: unknown; command?: unknown}, unavailable?: RuntimeSetError): void {
      if (id.writeSequence <= highestSequence) return;
      highestSequence = id.writeSequence;
      if (pending && interactionNow() >= pending.deadline) failPending('timeout');
      const request = readRequest(id, packet);
      const remaining = request ? request.deadline - interactionNow() : 0;
      const rejected = !request ? 'invalid_input' : unavailable ?? (remaining <= 0 ? 'timeout' : pending && 'busy');
      if (!request || rejected) {
        send({...id, result: runtimeWriteError(rejected || 'invalid_input')});
        return;
      }
      pending = {...request, cancelTimer: scheduleRuntimeWriteDeadline(request.deadline, () => {
        if (sameRuntimeWrite(pending, id)) failPending('timeout');
      })};
    },
    execute(): void {
      const current = takePending();
      if (!current) return;
      // Once adopted, a synchronous callback can request stop without falsely
      // settling this write as an undispatched pending operation.
      const result = interactionNow() >= current.deadline ? runtimeWriteError('timeout') : execute(current.command, current.deadline);
      send({requestId: current.requestId, writeSequence: current.writeSequence, result});
    },
    cancel(id: RuntimeWriteId): void {
      if (sameRuntimeWrite(pending, id)) failPending('cancelled');
    },
    stop(): void {
      failPending('run_ended');
    },
  };
}

export function createRuntimeWriteRelay(forward: (packet: WritePacket) => number | undefined, send: SendReply) {
  let highestSequence = 0;
  let pending: RuntimeWriteRequest | undefined;
  let requestDelivery: {id: RuntimeWriteId; dataSequence: number} | undefined;
  let cancelDelivery: number | undefined;

  function expire(): void {
    if (pending && interactionNow() >= pending.deadline) pending = undefined;
  }
  return {
    request(id: RuntimeWriteId, packet: {deadline?: unknown; command?: unknown}, unavailable?: RuntimeSetError): void {
      if (id.writeSequence <= highestSequence) return;
      highestSequence = id.writeSequence;
      expire();
      const request = readRequest(id, packet);
      if (!request || unavailable || request.deadline <= interactionNow() || pending || requestDelivery) {
        const error = !request ? 'invalid_input' : unavailable ?? (request.deadline <= interactionNow() ? 'timeout' : 'busy');
        send({...id, result: runtimeWriteError(error)});
        return;
      }
      let sequence: number | undefined;
      try { sequence = forward({type: 'runtime-write-request', ...request}); }
      catch {
        send({...id, result: runtimeWriteError('dispatch_failed')});
        return;
      }
      if (sequence === undefined) {
        send({...id, result: runtimeWriteError('busy')});
        return;
      }
      requestDelivery = {id, dataSequence: sequence};
      pending = request;
    },
    cancel(id: RuntimeWriteId): void {
      expire();
      if (!sameRuntimeWrite(pending, id) || cancelDelivery !== undefined) return;
      try { cancelDelivery = forward({type: 'runtime-write-cancel', ...id}); }
      catch { /* The Worker retains the original absolute deadline. */ }
    },
    receipt(dataSequence: number): void {
      if (requestDelivery?.dataSequence === dataSequence) requestDelivery = undefined;
      if (cancelDelivery === dataSequence) cancelDelivery = undefined;
    },
    reply(id: RuntimeWriteId, value: unknown): void {
      const result = readRuntimeWriteResult(value);
      if (!result) return;
      if (sameRuntimeWrite(requestDelivery?.id, id)) requestDelivery = undefined;
      if (!sameRuntimeWrite(pending, id)) return;
      pending = undefined;
      send({...id, result});
    },
    stop(): void {
      const current = pending;
      pending = undefined;
      if (current) send({requestId: current.requestId, writeSequence: current.writeSequence, result: runtimeWriteUnconfirmed('run_ended')});
    },
    dispose(): void {
      pending = undefined;
      requestDelivery = undefined;
      cancelDelivery = undefined;
    },
  };
}

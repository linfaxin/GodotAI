import {interactionNow, validInteractionId} from './worker-interaction.js';
import {
  MAX_OBSERVATION_TIMEOUT_MS, observationError, observationOk, readRuntimeObservationQuery,
  readRuntimeObservationReply, type ObservationResult, type RuntimeObservationQuery, type RuntimeObservationSample,
} from './worker-runtime-observation.js';

export type RuntimeObservationRequest = {requestId: string; deadline: number; query: RuntimeObservationQuery};
export type RuntimeObservationReply = {
  requestId: string;
  result: ObservationResult<RuntimeObservationSample>;
  sampleSeq?: number;
};
type RuntimeObservationPacket = ({type: 'runtime-observation-request'} & RuntimeObservationRequest) |
  {type: 'runtime-observation-cancel'; requestId: string};

export function readRuntimeObservationRequest(value: {
  requestId?: unknown; deadline?: unknown; query?: unknown;
}): RuntimeObservationRequest | undefined {
  const {requestId, deadline} = value;
  if (!validInteractionId(requestId) || typeof deadline !== 'number' || !Number.isFinite(deadline) ||
      deadline - interactionNow() > MAX_OBSERVATION_TIMEOUT_MS) return;
  const query = readRuntimeObservationQuery(value.query);
  if (query) return {requestId, deadline, query};
}

type PendingObservation = RuntimeObservationRequest & {timer: ReturnType<typeof setTimeout>};
type SendReply = (reply: RuntimeObservationReply) => void;

export function createWorkerObservationRequests(
  sample: (query: RuntimeObservationQuery) => ObservationResult<RuntimeObservationSample>,
  send: SendReply,
) {
  let pending: PendingObservation | undefined;
  let sampleSeq = 0;
  function finish(result: ObservationResult<RuntimeObservationSample>): void {
    if (!pending) return;
    const {requestId, timer} = pending;
    pending = undefined;
    clearTimeout(timer);
    send({requestId, result, ...(result.ok ? {sampleSeq: ++sampleSeq} : {})});
  }
  return {
    request(request: RuntimeObservationRequest): void {
      const remaining = request.deadline - interactionNow();
      if (remaining <= 0 || pending) {
        send({requestId: request.requestId, result: observationError(remaining <= 0 ? 'timeout' : 'busy')});
        return;
      }
      pending = {...request, timer: setTimeout(() => finish(observationError('timeout')), remaining)};
    },
    observe(): void {
      const request = pending;
      if (!request) return;
      if (interactionNow() >= request.deadline) {
        finish(observationError('timeout'));
        return;
      }
      const result = sample(request.query);
      if (request !== pending) return;
      finish(interactionNow() >= request.deadline ? observationError('timeout') : result);
    },
    cancel(requestId: string): void {
      if (pending?.requestId === requestId) finish(observationError('cancelled'));
    },
    stop(): void {
      finish(observationError('run_ended'));
    },
  };
}

/** Logical timeouts never release unconfirmed data-channel credit. A request
 * and its optional cancellation each occupy one physical sequence at most. */
export function createRuntimeObservationRelay(
  forward: (packet: RuntimeObservationPacket) => number | undefined,
  send: SendReply,
) {
  let pending: PendingObservation | undefined;
  let requestDelivery: {requestId: string; sequence: number} | undefined;
  let cancelDelivery: number | undefined;

  function clearPending(): PendingObservation | undefined {
    const current = pending;
    pending = undefined;
    if (current) clearTimeout(current.timer);
    return current;
  }

  function receipt(sequence: number): void {
    if (requestDelivery?.sequence === sequence) requestDelivery = undefined;
    if (cancelDelivery === sequence) cancelDelivery = undefined;
  }

  return {
    request(request: RuntimeObservationRequest): void {
      const remaining = request.deadline - interactionNow();
      if (remaining <= 0 || pending || requestDelivery) {
        send({requestId: request.requestId, result: observationError(remaining <= 0 ? 'timeout' : 'busy')});
        return;
      }
      try {
        const sequence = forward({type: 'runtime-observation-request', ...request});
        if (sequence !== undefined) {
          requestDelivery = {requestId: request.requestId, sequence};
          pending = {...request, timer: setTimeout(() => {
            clearPending();
            send({requestId: request.requestId, result: observationError('timeout')});
          }, remaining)};
          return;
        }
      } catch {
        send({requestId: request.requestId, result: observationError('observation_failed')});
        return;
      }
      send({requestId: request.requestId, result: observationError('busy')});
    },
    cancel(requestId: string): void {
      if (pending?.requestId !== requestId) return;
      clearPending();
      if (cancelDelivery !== undefined) return;
      try { cancelDelivery = forward({type: 'runtime-observation-cancel', requestId}); }
      catch { /* The Worker retains its own request deadline. */ }
    },
    receipt,
    reply(reply: {requestId?: unknown; result?: unknown; sampleSeq?: unknown}): void {
      if (requestDelivery && requestDelivery.requestId === reply.requestId) receipt(requestDelivery.sequence);
      if (!pending || pending.requestId !== reply.requestId) return;
      const current = clearPending()!;
      const result = interactionNow() >= current.deadline ? observationError('timeout') :
        readRuntimeObservationReply(current.query, reply);
      if (!result.ok) {
        send({requestId: current.requestId, result});
        return;
      }
      const {sampleSeq, ...value} = result.result;
      send({requestId: current.requestId, result: observationOk(value), sampleSeq});
    },
    stop(): void {
      const current = clearPending();
      if (current) send({requestId: current.requestId, result: observationError('run_ended')});
    },
    dispose(): void {
      clearPending();
      requestDelivery = undefined;
      cancelDelivery = undefined;
    },
  };
}

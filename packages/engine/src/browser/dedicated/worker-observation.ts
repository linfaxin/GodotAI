import {
  MAX_CAPTURE_BYTES, MAX_CAPTURE_DIMENSION, interactionNow, undispatched,
  type CapturedFrame, type GameGesture, type InputEvidence,
} from './worker-interaction.js';
import type {CanvasGeometry} from './worker-presentation.js';

interface CaptureJob {
  id: string;
  deadline: number;
  after: number;
  timer: ReturnType<typeof setTimeout>;
  encoding: boolean;
  error?: 'timeout' | 'run_ended' | 'cancelled';
}

export function createWorkerCapture(
  canvas: OffscreenCanvas,
  eligible: () => boolean,
  send: (id: string, frame?: CapturedFrame, error?: 'timeout' | 'run_ended' | 'cancelled' | 'capture_failed' | 'busy') => void,
  fitsBudget: (estimatedBytes: number) => boolean = () => true,
  onRelease: () => void = () => {},
) {
  let serial = 0, reservedBytes = 0;
  let job: CaptureJob | undefined;

  function finish(current: CaptureJob, frame?: CapturedFrame, error?: 'timeout' | 'run_ended' | 'capture_failed') {
    if (job !== current) return;
    clearTimeout(current.timer);
    job = undefined;
    const reason = current.error ?? (interactionNow() >= current.deadline ? 'timeout' : error);
    send(current.id, reason ? undefined : frame, reason);
  }

  function cancel(reason: 'timeout' | 'run_ended' | 'cancelled') {
    if (!job) return;
    job.error ??= reason;
    if (!job.encoding) finish(job);
  }

  return {
    get reservedBytes() { return reservedBytes; },
    request(id: string, deadline: number) {
      if (job) { send(id, undefined, 'busy'); return; }
      const remaining = deadline - interactionNow();
      if (remaining <= 0) { send(id, undefined, 'timeout'); return; }
      const timer = setTimeout(() => cancel('timeout'), remaining);
      job = {id, deadline, after: serial, timer, encoding: false};
    },
    cancel(id: string) { if (job?.id === id) cancel('cancelled'); },
    stop() { cancel('run_ended'); },
    frame(iteration: number, renderSerial: number, geometry: CanvasGeometry) {
      if (renderSerial <= serial) return;
      serial = renderSerial;
      const current = job;
      if (!current || current.encoding || renderSerial <= current.after) return;
      if (interactionNow() >= current.deadline) { finish(current); return; }
      if (!eligible() || !canvas.width || !canvas.height) return;
      const gl = (canvas as OffscreenCanvas & {GLctxObject?: {GLctx?: WebGL2RenderingContext}}).GLctxObject?.GLctx;
      if (!gl || gl.isContextLost()) { finish(current, undefined, 'capture_failed'); return; }
      const sourceWidth = canvas.width, sourceHeight = canvas.height;
      const scale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
      const estimate = sourceWidth * sourceHeight * 4 + width * height * 8 + MAX_CAPTURE_BYTES;
      if (!fitsBudget(estimate)) {
        finish(current, undefined, 'capture_failed');
        return;
      }
      reservedBytes = estimate;
      let scratch: OffscreenCanvas | undefined;
      try {
        scratch = new OffscreenCanvas(width, height);
        const ctx = scratch.getContext('2d', {alpha: true, colorSpace: 'srgb'});
        if (!ctx) throw Error('No capture context');
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(canvas, 0, 0, width, height);
      } catch {
        if (scratch) { scratch.width = 0; scratch.height = 0; }
        reservedBytes = 0;
        onRelease();
        finish(current, undefined, 'capture_failed');
        return;
      }
      current.encoding = true;
      const target = scratch;
      const observedGeometry = {...geometry};
      queueMicrotask(async () => {
        let frame: CapturedFrame | undefined;
        let error: 'capture_failed' | undefined;
        try {
          if (current.error) return;
          const blob = await target.convertToBlob({type: 'image/png'});
          if (blob.size > MAX_CAPTURE_BYTES || blob.type !== 'image/png' || gl.isContextLost()) {
            throw Error('Capture encoding failed');
          }
          if (current.error || interactionNow() >= current.deadline) return;
          const bytes = await blob.arrayBuffer();
          if (gl.isContextLost()) throw Error('Capture context lost');
          frame = {renderSerial, iteration, geometry: observedGeometry, sourceWidth, sourceHeight, width, height, mimeType: 'image/png', bytes};
        } catch {
          error = 'capture_failed';
        } finally {
          target.width = 0;
          target.height = 0;
          reservedBytes = 0;
          onRelease();
          finish(current, frame, error);
        }
      });
    },
  };
}

/** A gesture is synchronous in the Worker bridge. Native input may be buffered. */
export function createWorkerGesture(
  send: (id: string, evidence: InputEvidence) => void,
  admissible: (gesture: GameGesture) => InputEvidence['reason'],
  dispatch: (gesture: GameGesture, down: boolean) => boolean,
) {
  let highWater = 0;
  let current: {id: string; evidence: InputEvidence} | undefined;
  return {
    perform(id: string, sequence: number, deadline: number, gesture: GameGesture) {
      if (sequence <= highWater) return;
      highWater = sequence;
      const reason = interactionNow() >= deadline ? 'expired' : admissible(gesture);
      if (reason) { send(id, undispatched(reason)); return; }
      const operation = {id, evidence: undispatched(undefined)};
      current = operation;
      try {
        for (const edge of ['down', 'up'] as const) {
          const rejection = admissible(gesture);
          if (rejection) { operation.evidence.reason = rejection; break; }
          operation.evidence[edge] = 'unconfirmed';
          const delivered = dispatch(gesture, edge === 'down');
          if (current !== operation) return;
          operation.evidence[edge] = delivered ? 'dispatched' : 'not_dispatched';
          if (!delivered) { operation.evidence.reason = 'not_ready'; break; }
        }
      } finally {
        if (current === operation) {
          current = undefined;
          send(id, operation.evidence);
        }
      }
    },
    exit() {
      if (!current) return;
      const operation = current;
      current = undefined;
      send(operation.id, {...operation.evidence, reason: 'run_ended'});
    },
  };
}

import {
  MAX_CAPTURE_BYTES, MAX_CAPTURE_DIMENSION, interactionNow, undispatched,
  type CapturedFrame, type GameGesture, type InputEvidence,
} from './worker-interaction.js';
import type {CanvasGeometry} from './worker-presentation.js';

type CaptureKind = 'screenshot' | 'probe';
type CaptureError = 'timeout' | 'run_ended' | 'cancelled' | 'capture_failed' | 'busy';
interface CaptureJob {
  id: string;
  kind: CaptureKind;
  deadline: number;
  after: number;
  maxDimension: number;
  timer: ReturnType<typeof setTimeout>;
  encoding: boolean;
  error?: CaptureError;
  frozen?: {canvas: OffscreenCanvas; frame: Omit<CapturedFrame, 'mimeType' | 'bytes'>; gl: WebGL2RenderingContext};
}

export function createWorkerCapture(
  canvas: OffscreenCanvas,
  eligible: () => boolean,
  send: (id: string, frame?: CapturedFrame, error?: CaptureError, kind?: CaptureKind) => void,
  fitsBudget: (estimatedBytes: number) => boolean = () => true,
  onRelease: () => void = () => {},
) {
  let serial = 0, reservedBytes = 0;
  let job: CaptureJob | undefined;

  function release(current: CaptureJob) {
    const frozen = current.frozen;
    if (!frozen) return;
    current.frozen = undefined;
    frozen.canvas.width = 0;
    frozen.canvas.height = 0;
    reservedBytes = 0;
    onRelease();
  }

  function finish(current: CaptureJob, frame?: CapturedFrame, error?: CaptureError) {
    if (job !== current) return;
    clearTimeout(current.timer);
    job = undefined;
    const reason = current.error ?? (interactionNow() >= current.deadline ? 'timeout' : error);
    try { release(current); }
    finally { send(current.id, reason ? undefined : frame, reason, current.kind); }
  }

  function cancel(reason: CaptureError) {
    if (!job) return;
    job.error ??= reason;
    if (!job.encoding) finish(job);
  }

  function freeze(current: CaptureJob, iteration: number, renderSerial: number, geometry: CanvasGeometry): boolean {
    if (current.frozen || current.encoding || renderSerial <= current.after ||
        interactionNow() >= current.deadline || !eligible() || !canvas.width || !canvas.height) return false;
    const gl = (canvas as OffscreenCanvas & {GLctxObject?: {GLctx?: WebGL2RenderingContext}}).GLctxObject?.GLctx;
    if (!gl || gl.isContextLost()) return false;
    const sourceWidth = canvas.width, sourceHeight = canvas.height;
    const scale = Math.min(1, current.maxDimension / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
    const estimate = sourceWidth * sourceHeight * 4 + width * height * 8 + MAX_CAPTURE_BYTES;
    if (!fitsBudget(estimate)) return false;
    reservedBytes = estimate;
    let scratch: OffscreenCanvas | undefined;
    try {
      scratch = new OffscreenCanvas(width, height);
      const ctx = scratch.getContext('2d', {alpha: true, colorSpace: 'srgb'});
      if (!ctx) throw Error('No capture context');
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(canvas, 0, 0, width, height);
      current.frozen = {canvas: scratch, gl,
        frame: {renderSerial, iteration, geometry: {...geometry}, sourceWidth, sourceHeight, width, height}};
      return true;
    } catch {
      if (scratch) { scratch.width = 0; scratch.height = 0; }
      reservedBytes = 0;
      onRelease();
      return false;
    }
  }

  function encode(current: CaptureJob) {
    if (!current.frozen || current.encoding) return;
    current.encoding = true;
    const {canvas: target, frame: metadata, gl} = current.frozen;
    queueMicrotask(async () => {
      let frame: CapturedFrame | undefined;
      let error: CaptureError | undefined;
      try {
        if (current.error) return;
        const blob = await target.convertToBlob({type: 'image/png'});
        if (blob.size > MAX_CAPTURE_BYTES || blob.type !== 'image/png' || gl.isContextLost())
          throw Error('Capture encoding failed');
        if (current.error || interactionNow() >= current.deadline) return;
        const bytes = await blob.arrayBuffer();
        if (gl.isContextLost()) throw Error('Capture context lost');
        frame = {...metadata, mimeType: 'image/png', bytes};
      } catch {
        error = 'capture_failed';
      } finally {
        finish(current, frame, error);
      }
    });
  }

  return {
    get reservedBytes() { return reservedBytes; },
    get busy() { return job !== undefined; },
    request(id: string, deadline: number, kind: CaptureKind = 'screenshot', maxDimension = MAX_CAPTURE_DIMENSION) {
      if (job) {
        if (job.id !== id || job.kind !== kind) send(id, undefined, 'busy', kind);
        return false;
      }
      const remaining = () => Math.ceil(deadline - interactionNow());
      if (remaining() <= 0) { send(id, undefined, 'timeout', kind); return false; }
      const check = () => {
        if (job !== current) return;
        const delay = remaining();
        if (delay <= 0) cancel('timeout');
        else current.timer = setTimeout(check, delay);
      };
      const current = {id, kind, deadline, maxDimension, after: serial, timer: setTimeout(check, remaining()), encoding: false};
      job = current;
      return true;
    },
    cancel(id: string, kind: CaptureKind = 'screenshot') { if (job?.id === id && job.kind === kind) cancel('cancelled'); },
    stop() { cancel('run_ended'); },
    freezeProbe(id: string, iteration: number, renderSerial: number, geometry: CanvasGeometry) {
      return !!job && job.id === id && job.kind === 'probe' && freeze(job, iteration, renderSerial, geometry);
    },
    finishProbe(id: string, error?: CaptureError) {
      if (job?.id !== id || job.kind !== 'probe') return;
      if (error) cancel(error);
      else if (job.frozen) encode(job);
      else finish(job, undefined, 'capture_failed');
    },
    frame(iteration: number, renderSerial: number, geometry: CanvasGeometry) {
      if (renderSerial <= serial) return;
      serial = renderSerial;
      const current = job;
      if (!current || current.kind !== 'screenshot' || current.encoding || renderSerial <= current.after) return;
      if (interactionNow() >= current.deadline) { finish(current); return; }
      if (!eligible() || !canvas.width || !canvas.height) return;
      if (freeze(current, iteration, renderSerial, geometry)) encode(current);
      else finish(current, undefined, 'capture_failed');
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

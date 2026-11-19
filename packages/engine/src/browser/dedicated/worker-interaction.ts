import type {CanvasGeometry} from './worker-presentation.js';
import type {WorkerRunIdentity} from './worker-protocol.js';
import type {VerifiedRelease} from '../verified-loader.js';

export const INTERACTION_VERSION = 1;
export const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
export const MAX_CAPTURE_DIMENSION = 1024;
export const INPUT_START_MS = 2000;
export const INPUT_RECEIPT_MS = 3000;

export function supportsWorkerInteraction(release: Pick<VerifiedRelease, 'profile' | 'engineTarget'>,
  presentationBackend: 'direct' | 'bitmap' | undefined, userAgent: string): boolean {
  return presentationBackend === 'direct' && release.profile === 'full-engine-v1' &&
    release.engineTarget === 'template_debug' && /\b(?:HeadlessChrome|Chromium|Chrome)\//.test(userAgent);
}

const keys = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
export type GameGesture = {kind: 'key_tap'; code: typeof keys[number]} |
  {kind: 'primary_click'; x: number; y: number; geometryEpoch: number};
export type InteractionError = 'invalid_input' | 'not_found' | 'not_ready' | 'unsupported' | 'busy' |
  'cancelled' | 'timeout' | 'run_ended' | 'geometry_conflict' | 'capture_failed' | 'input_conflict';
export type InteractionResult<T> = {ok: true; result: T} | {ok: false; error: {code: InteractionError; message: string}};
export const interactionOk = <T>(result: T): InteractionResult<T> => ({ok: true, result});
export const interactionError = (code: InteractionError): InteractionResult<never> => ({ok: false, error: {code, message: code}});

export type InputEdge = 'not_dispatched' | 'dispatched' | 'unconfirmed';
export interface InputEvidence {
  down: InputEdge;
  up: InputEdge;
  reason?: 'expired' | 'geometry_conflict' | 'input_conflict' | 'run_ended' | 'busy' | 'not_ready' | 'transport';
}
export interface InputReceipt extends InputEvidence {
  operationId: string;
  run: WorkerRunIdentity;
  status: 'pending' | 'dispatched' | 'not_dispatched' | 'partial' | 'unconfirmed';
  nativeConsumption: 'unconfirmed';
}
export interface CapturedFrame {
  renderSerial: number;
  iteration: number;
  geometry: CanvasGeometry;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  mimeType: 'image/png';
  bytes: ArrayBuffer;
}
export interface GameScreenshot extends CapturedFrame {
  requestId: string;
  run: WorkerRunIdentity;
  releaseId: string;
}
export type ScreenshotInput = {runId: string; timeoutMs?: number};
export type GameInput = {runId: string; gesture: GameGesture};
export type WaitForInput = {runId: string; operationId: string; timeoutMs?: number};

export const interactionNow = () => performance.timeOrigin + performance.now();
export const validInteractionId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64;
export const validInteractionSequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const point = (value: unknown): value is number => typeof value === 'number' && value >= 0 && value < 1;
export function readGesture(value: unknown): GameGesture | undefined {
  if (!value || typeof value !== 'object') return;
  const gesture = value as GameGesture;
  if (gesture.kind === 'key_tap' && keys.includes(gesture.code)) return {kind: gesture.kind, code: gesture.code};
  if (gesture.kind === 'primary_click' && point(gesture.x) && point(gesture.y) && validInteractionSequence(gesture.geometryEpoch))
    return {kind: gesture.kind, x: gesture.x, y: gesture.y, geometryEpoch: gesture.geometryEpoch};
}
export const undispatched = (reason: InputEvidence['reason']): InputEvidence =>
  ({down: 'not_dispatched', up: 'not_dispatched', reason});
export function readInputEvidence(value: unknown): InputEvidence | undefined {
  const evidence = value as InputEvidence | undefined;
  if (!evidence || !['not_dispatched', 'dispatched', 'unconfirmed'].includes(evidence.down) ||
      !['not_dispatched', 'dispatched', 'unconfirmed'].includes(evidence.up) ||
      (evidence.reason !== undefined && !['expired', 'geometry_conflict', 'input_conflict', 'run_ended', 'busy', 'not_ready', 'transport'].includes(evidence.reason))) return;
  return {down: evidence.down, up: evidence.up, ...(evidence.reason ? {reason: evidence.reason} : {})};
}
export function inputStatus(evidence: InputEvidence): InputReceipt['status'] {
  if (evidence.down === 'unconfirmed' || evidence.up === 'unconfirmed') return 'unconfirmed';
  if (evidence.down === evidence.up) return evidence.down;
  return 'partial';
}
export function isCapturedFrame(value: unknown): value is CapturedFrame {
  const frame = value as CapturedFrame | undefined;
  return !!frame && validInteractionSequence(frame.renderSerial) && validInteractionSequence(frame.iteration) &&
    validInteractionSequence(frame.geometry?.epoch) && Number.isFinite(frame.geometry.width) && frame.geometry.width > 0 &&
    Number.isFinite(frame.geometry.height) && frame.geometry.height > 0 &&
    validInteractionSequence(frame.sourceWidth) && validInteractionSequence(frame.sourceHeight) &&
    validInteractionSequence(frame.width) && frame.width <= Math.min(frame.sourceWidth, MAX_CAPTURE_DIMENSION) &&
    validInteractionSequence(frame.height) && frame.height <= Math.min(frame.sourceHeight, MAX_CAPTURE_DIMENSION) &&
    frame.mimeType === 'image/png' && frame.bytes instanceof ArrayBuffer &&
    frame.bytes.byteLength > 8 && frame.bytes.byteLength <= MAX_CAPTURE_BYTES &&
    new DataView(frame.bytes).getUint32(0) === 0x89504e47 && new DataView(frame.bytes).getUint32(4) === 0x0d0a1a0a;
}

/** This protocol routes untrusted preview telemetry; it does not attest user code. */
export const PREVIEW_PROTOCOL = 1 as const;
export type Revision = string | number;
export interface RunIdentity {
  runId: string;
  revision: Revision;
  buildKey: string;
  generation: Revision;
}
export interface BrowserArtifact {
  revision: Revision;
  buildKey: string;
  generation: Revision;
  pack: Uint8Array;
  manifest: unknown;
}
export type RunPhase = 'downloading' | 'preloading' | 'initializing' | 'starting' | 'waiting-ready' | 'running';
export type RunnerState = 'idle' | 'loading-frame' | 'handshaking' | RunPhase | 'stopping' | 'exited';
export type ExitReason = 'clean-exit' | 'forced-frame-disposal' | 'crashed' | 'unresponsive';
export interface ExitReport extends RunIdentity {
  reason: ExitReason;
  code?: number;
  detail?: string;
}
export interface PhaseDeadlines {
  'loading-frame': number;
  handshaking: number;
  downloading: number;
  preloading: number;
  initializing: number;
  starting: number;
  'waiting-ready': number;
  /** Zero disables the running wall-clock deadline. */
  running: number;
  stopping: number;
  heartbeat: number;
}
export const DEFAULT_DEADLINES: PhaseDeadlines = {
  'loading-frame': 15_000, handshaking: 5_000, downloading: 90_000,
  preloading: 15_000, initializing: 60_000, starting: 30_000,
  'waiting-ready': 15_000, running: 0, stopping: 3_000, heartbeat: 5_000,
};
export const RUN_PHASES: readonly RunPhase[] = ['downloading', 'preloading', 'initializing', 'starting', 'waiting-ready', 'running'];
export interface PreviewEnvelope extends RunIdentity {
  protocolVersion: typeof PREVIEW_PROTOCOL;
  type: 'connected' | 'phase' | 'heartbeat' | 'log' | 'fatal' | 'exited';
  phase?: RunPhase;
  level?: 'log' | 'warn' | 'error';
  text?: string;
  code?: number;
}
export type RunnerEvent =
  | ({ type: 'state'; state: RunnerState } & RunIdentity)
  | ({ type: 'log'; level: 'log' | 'warn' | 'error'; text: string; untrusted: true } & RunIdentity)
  | ({ type: 'exit'; report: ExitReport });

const boundedString = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const revision = (value: unknown): value is Revision => boundedString(value) || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
export function isIdentity(value: unknown): value is RunIdentity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return boundedString(v.runId) && revision(v.revision) && boundedString(v.buildKey) && revision(v.generation);
}
export function sameRun(a: RunIdentity, b: RunIdentity): boolean {
  return a.runId === b.runId && a.revision === b.revision && a.buildKey === b.buildKey && a.generation === b.generation;
}
export function isPreviewEnvelope(value: unknown): value is PreviewEnvelope {
  if (!isIdentity(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  if (v.protocolVersion !== PREVIEW_PROTOCOL) return false;
  switch (v.type) {
    case 'connected': case 'heartbeat': return true;
    case 'phase': return RUN_PHASES.includes(v.phase as RunPhase);
    case 'log': return ['log', 'warn', 'error'].includes(v.level as string) && typeof v.text === 'string' && v.text.length <= 4096;
    case 'fatal': return typeof v.text === 'string' && v.text.length <= 4096;
    case 'exited': return typeof v.code === 'number' && Number.isSafeInteger(v.code);
    default: return false;
  }
}

export function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === 'null') throw new Error('E_PREVIEW_ORIGIN');
  return url.origin;
}

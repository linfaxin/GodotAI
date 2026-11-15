/** This protocol routes untrusted preview telemetry; it does not attest user code. */
import type {SessionCleanupReceipt} from './engine-session.js';
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
  /** Outer receipt hash, deliberately excluded from the pack's own manifest. */
  packSha256?:string;
  artifactId?:string;
  /** Explicit opt-in stamped by a compatibility runner; new releases reject it. */
  compatibility?:'legacy-artifact-v1';
}
export type RunPhase = 'downloading' | 'preloading' | 'initializing' | 'starting' | 'waiting-ready' | 'running';
export type RunnerState = 'idle' | 'loading-frame' | 'handshaking' | RunPhase | 'stopping' | 'exited';
export type ExitReason = 'clean-exit' | 'forced-frame-disposal' | 'forced-session-termination' | 'crashed' | 'unresponsive';
export interface PreviewDiagnostic {
  source: 'browser' | 'godotjs' | 'godot';
  message: string;
  name?: string;
  stack?: string;
  filename?: string;
  line?: number;
  column?: number;
}
export interface ExitReport extends RunIdentity {
  reason: ExitReason;
  code?: number;
  detail?: string;
  diagnostic?: PreviewDiagnostic;
  cleanup?: SessionCleanupReceipt;
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
  type: 'connected' | 'phase' | 'heartbeat' | 'engine-progress' | 'terminated' | 'log' | 'fatal' | 'exited' | 'project';
  data?: Record<string,unknown>;
  phase?: RunPhase;
  level?: 'log' | 'warn' | 'error';
  text?: string;
  code?: number;
  diagnostic?: PreviewDiagnostic;
  cleanup?: SessionCleanupReceipt;
  sequence?: number;
  workerId?: number;
  role?: 'engine';
}
export type RunnerEvent =
  | ({ type: 'state'; state: RunnerState } & RunIdentity)
  | ({ type: 'log'; level: 'log' | 'warn' | 'error'; text: string; untrusted: true } & RunIdentity)
  | ({ type: 'project'; data: Record<string,unknown> } & RunIdentity)
  | ({ type: 'exit'; report: ExitReport });

const boundedString = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const revision = (value: unknown): value is Revision => boundedString(value) || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const optionalString = (value: unknown, limit: number): boolean => value === undefined || (typeof value === 'string' && value.length <= limit);
const optionalPosition = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
export function isPreviewDiagnostic(value: unknown): value is PreviewDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return ['browser', 'godotjs', 'godot'].includes(d.source as string) && typeof d.message === 'string' && d.message.length <= 4096 &&
    optionalString(d.name, 256) && optionalString(d.stack, 32768) && optionalString(d.filename, 2048) && optionalPosition(d.line) && optionalPosition(d.column);
}

// Capture the intrinsic before project code can install accessors on Error fields.
const intrinsicStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
function ownText(value: object, field: string, limit: number): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    // Some browsers expose Error.stack through a shared native accessor.
    const text = descriptor && 'value' in descriptor ? descriptor.value :
      field === 'stack' && intrinsicStackGetter ? intrinsicStackGetter.call(value) : undefined;
    return typeof text === 'string' ? text.slice(0, limit) : undefined;
  } catch { return undefined; }
}
/** Bounded plain data only; never recursively serialize arbitrary project objects. */
export function previewDiagnostic(error: unknown, location: { message?: string; filename?: string; line?: number; column?: number } = {}): PreviewDiagnostic {
  let message: string | undefined, name: string | undefined, stack: string | undefined;
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    message = ownText(error, 'message', 4096); name = ownText(error, 'name', 256); stack = ownText(error, 'stack', 32768);
  } else if (typeof error === 'string') message = error.slice(0, 4096);
  else if ((error === null || error === undefined) && location.message !== undefined) message = location.message.slice(0, 4096);
  else if (error === null || ['undefined', 'number', 'boolean', 'bigint'].includes(typeof error)) message = String(error).slice(0, 4096);
  return { source: 'browser', message: message ?? location.message?.slice(0, 4096) ?? 'Unhandled preview error',
    ...(name === undefined ? {} : { name }), ...(stack === undefined ? {} : { stack }),
    ...(location.filename ? { filename: location.filename.slice(0, 2048) } : {}),
    ...(optionalPosition(location.line) && location.line !== undefined ? { line: location.line } : {}),
    ...(optionalPosition(location.column) && location.column !== undefined ? { column: location.column } : {}) };
}
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
    case 'engine-progress': return v.role==='engine'&&Number.isSafeInteger(v.sequence)&&Number(v.sequence)>0&&Number.isSafeInteger(v.workerId)&&Number(v.workerId)>=0;
    case 'terminated': return isSessionCleanupReceipt(v.cleanup)&&v.cleanup.mode==='forced';
    case 'project': return isProjectData(v.data);
    case 'phase': return RUN_PHASES.includes(v.phase as RunPhase);
    case 'log': return ['log', 'warn', 'error'].includes(v.level as string) && typeof v.text === 'string' && v.text.length <= 4096;
    case 'fatal': return typeof v.text === 'string' && v.text.length <= 4096 && (v.diagnostic === undefined || isPreviewDiagnostic(v.diagnostic))&&(v.cleanup===undefined||isSessionCleanupReceipt(v.cleanup));
    case 'exited': return typeof v.code === 'number' && Number.isSafeInteger(v.code)&&(v.cleanup===undefined||isSessionCleanupReceipt(v.cleanup));
    default: return false;
  }
}

export function isSessionCleanupReceipt(value:unknown):value is SessionCleanupReceipt {
  if(!isProjectData(value)||!['clean','forced'].includes(String(value.mode)))return false;
  for(const key of ['workers','terminatedWorkers','audioContexts','closedAudioContexts','clearedTimers','removedListeners'])if(!Number.isSafeInteger(value[key])||Number(value[key])<0)return false;
  for(const key of ['mediaStreams','mediaTracks','stoppedMediaTracks','networkResources','closedNetworkResources','messagePorts','closedMessagePorts','glContexts','glLossRequested','lostGlContexts'])if(value[key]!==undefined&&(!Number.isSafeInteger(value[key])||Number(value[key])<0))return false;
  if(Number(value.stoppedMediaTracks??0)>Number(value.mediaTracks??0)||Number(value.closedNetworkResources??0)>Number(value.networkResources??0))return false;
  if(Number(value.closedMessagePorts??0)>Number(value.messagePorts??0)||Number(value.lostGlContexts??0)>Number(value.glContexts??0)||Number(value.glLossRequested??0)>Number(value.glContexts??0))return false;
  return Array.isArray(value.errors)&&value.errors.length<=64&&value.errors.every(item=>typeof item==='string'&&item.length<=4096)&&Number(value.terminatedWorkers)<=Number(value.workers)&&Number(value.closedAudioContexts)<=Number(value.audioContexts);
}

export function sessionCleanupComplete(value:SessionCleanupReceipt):boolean {
  return value.errors.length===0&&value.terminatedWorkers===value.workers&&value.closedAudioContexts===value.audioContexts&&(value.stoppedMediaTracks??0)===(value.mediaTracks??0)&&(value.closedNetworkResources??0)===(value.networkResources??0)&&(value.closedMessagePorts??0)===(value.messagePorts??0)&&(value.lostGlContexts??0)===(value.glContexts??0);
}

/** Only plain bounded JSON crosses the optional project UI channel. */
export function isProjectData(value:unknown):value is Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 try{let size=0;const inspect=(item:unknown,depth=0):boolean=>{if(depth>16)return false;if(item===null||typeof item==='boolean')return true;if(typeof item==='number')return Number.isFinite(item);if(typeof item==='string'){size+=item.length;return size<=262144;}if(!item||typeof item!=='object')return false;const proto=Object.getPrototypeOf(item);if(!Array.isArray(item)&&proto!==Object.prototype&&proto!==null)return false;return Object.entries(Object.getOwnPropertyDescriptors(item)).every(([key,d])=>{size+=key.length+8;return size<=262144&&'value'in d&&inspect(d.value,depth+1);});};return inspect(value);}catch{return false;}
}

export function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === 'null') throw new Error('E_PREVIEW_ORIGIN');
  return url.origin;
}

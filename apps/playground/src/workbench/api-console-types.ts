import type {GameScreenshot, RuntimeMethodToken} from '@godot-js/engine/browser/dedicated/worker-runner';
import type {WorkerRunIdentity} from '@godot-js/engine/browser/dedicated/worker-protocol';
import type {RunnerState} from '@godot-js/engine/browser/protocol';
import type {RuntimeType} from '@godot-js/engine/browser/dedicated/worker-runtime-properties';
import type {FacadeReply, SelectedRuntimeMethod} from '../summer-adapter';
import type {ProjectFileReceipt} from '../project-file-access';

export interface ConsoleAnchor {
  editorProjectId: string | null;
  editorRevision: number | null;
  activeRunId: string | null;
  activeRunProjectId: string | null;
  activeRunRevision: WorkerRunIdentity['revision'] | null;
  pendingAttemptId: string | null;
}
export interface ConsoleCapability {supported: boolean | null; ready: boolean}
export interface ConsoleEnvironment {
  anchor: ConsoleAnchor;
  activeRunState: RunnerState | null;
  methodExampleAvailable?: boolean;
  inputExampleAvailable?: boolean;
  capabilities?: {
    observation?: ConsoleCapability;
    runtimeWrite?: ConsoleCapability;
    runtimeProperties?: ConsoleCapability;
    runtimeCall?: ConsoleCapability;
    gameProbe?: ConsoleCapability;
    inputScript?: ConsoleCapability;
    interaction?: ConsoleCapability;
  };
}
export interface ConsoleDraft {
  operationId: string;
  inputText: string;
  anchor: ConsoleAnchor;
  selectedMethod?: SelectedRuntimeMethod;
  runSourceCallId?: string | null;
  needsEventCursor?: boolean;
}
export interface ConsoleResultFacts {
  sourceCallId: string;
  sourceAnchor: ConsoleAnchor;
  attemptId?: string;
  run?: {identity: WorkerRunIdentity; projectId?: string; attemptId?: string};
  nodes?: {path: string; instanceId: string; type: string}[];
  propertyTarget?: {runId: string; path: string; expectedInstanceId: string};
  properties?: {name: string; type: RuntimeType}[];
  methods?: {name: string; signature: string; token: RuntimeMethodToken; parameterTypes: SelectedRuntimeMethod['parameterTypes']}[];
  input?: {runId: string; operationId: string};
  geometryEpoch?: number;
  stoppedRunIds?: string[];
  eventCursor?: {since: number; stream_id: string};
  file?: Pick<ProjectFileReceipt, 'path' | 'projectId' | 'editorRevision' | 'sha256'>;
  truncated?: true;
}
export interface ConsoleCall {
  callId: string;
  draft: ConsoleDraft;
  submittedAt: number;
  settledAt?: number;
  phase: 'pending' | 'settled' | 'thrown';
  summary?: string;
  resultProjection?: string;
  resultFacts?: ConsoleResultFacts;
  truncated?: boolean;
  attachmentId?: string;
  attachmentReleased?: boolean;
}
export type ConsoleToken = symbol;
export type ConsoleOwner = 'manual' | 'replay' | 'open-example' | 'recovery';
export interface ConsoleGate {
  acquire(owner: ConsoleOwner): ConsoleToken | undefined;
  release(token: ConsoleToken): void;
  owner(): ConsoleOwner | null;
  subscribe(listener: () => void): () => void;
}
export interface ConsoleHooks {
  readContext(): ConsoleEnvironment;
  subscribeContext(listener: () => void): () => void;
  callSelectedMethod(input: unknown, signal: AbortSignal | undefined, selected: SelectedRuntimeMethod): Promise<FacadeReply>;
  openExample(operationId: string): Promise<string>;
  cancelLaunch?(attemptId: string): void;
}
export interface ConsoleFillSelection {
  sourceCallId: string;
  nodePath?: string;
  probeTarget?: 'tree' | 'properties';
  methodName?: string;
  propertyNames?: readonly string[];
  stoppedRunId?: string;
}
export interface ConsoleSnapshot {
  operationId: string;
  draft: ConsoleDraft;
  environment: ConsoleEnvironment;
  owner: ConsoleOwner | null;
  history: readonly ConsoleCall[];
  pendingCallId?: string;
  cancellable: boolean;
  recovery?: {phase: 'running' | 'passed' | 'cancelled' | 'failed'; message: string};
  clientError?: {kind: 'json' | 'stale_target' | 'wrong_project' | 'missing_source'; message: string};
}
export interface ConsoleAttachment {blob: Blob; metadata: Omit<GameScreenshot, 'bytes'>}
export interface ConsoleSession {
  snapshot(): ConsoleSnapshot;
  subscribe(listener: () => void): () => void;
  selectOperation(operationId: string): void;
  updateDraft(inputText: string): void;
  loadPreset(operationId: string, inputText: string, needsRunSource?: boolean, needsEventCursor?: boolean): void;
  loadHistory(callId: string): void;
  updateTarget(source?: ConsoleFillSelection): void;
  submit(): Promise<void>;
  cancel(): void;
  openExample(): Promise<void>;
  runRecovery(show: () => void): Promise<void>;
  cancelRecovery(): boolean;
  hasCall(callId: string): boolean;
  getAttachment(id: string): ConsoleAttachment | undefined;
  clearSettled(): void;
  dispose(): void;
}

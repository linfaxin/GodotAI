import type { NativeKey, NativeOpResult, CommitTicket } from "./contracts";

export type RuntimePhase = "idle" | "initial" | "safe" | "cleanup" | "process" | "physics" | "input";
export interface NativeInfo {
  type: string;
  name: string;
  parent: NativeKey | null;
  alive: boolean;
  insideTree?: boolean;
  ready?: boolean;
}
export interface NativeInvalidation { key: NativeKey; expected?: boolean; reason?: string; retirementBatch?: string }
/** Private renderer backend. Node/Resource objects must never cross its public facade. */
export interface NativePort {
  create(type: string, scriptProfile?: string): NativeKey;
  read(key: NativeKey, property: string): unknown;
  set(key: NativeKey, property: string, value: unknown): unknown;
  append(parent: NativeKey, child: NativeKey, index: number): void;
  remove(parent: NativeKey, child: NativeKey): void;
  free(key: NativeKey, retirementBatch?: string): void;
  setOwner?(key:NativeKey,owner:NativeKey|null):void;
  children(key: NativeKey): readonly NativeKey[];
  info(key: NativeKey): NativeInfo;
  isAlive(key: NativeKey): boolean;
  nativeIdentity?(key: NativeKey): string;
  nativeRpc?(key: NativeKey, method: string, args: readonly unknown[], peerId?: number): number;
  localizeAsset?(id: string, instance: string, root: NativeKey): unknown;
  finishAssetScope?(instance: string): void;
  releaseAssetScope?(instance: string): void;
  connect(key: NativeKey, signal: string, callback: (...args: unknown[]) => void): () => void;
  beginStage(phase: Exclude<RuntimePhase, "idle">): void;
  endStage(): void;
  setOperationContext?(ticket: CommitTicket, operationEpoch: number): void;
  getNativeOperationResults?(): readonly NativeOpResult[];
  audit?(): void;
  takeInvalidations?(): readonly NativeInvalidation[];
  command?(key: NativeKey, method: string, args: readonly unknown[]): unknown;
  loadAsset?(path: string, type: string): unknown;
  releaseAsset?(id: string): void;
  quiesce?(): void;
  forceClose?(): void;
  close?(): void;
}
export const nativeKeyId = (key: NativeKey): string => `${key.slot}:${key.revision}`;

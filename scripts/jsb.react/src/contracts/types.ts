export const CONTRACT_VERSION = 1 as const;
export const RUNTIME_ABI = "godot-react/1" as const;
export const NATIVE_BRIDGE_ABI = "godot-react-native/1" as const;
export const REACT_VERSIONS = Object.freeze({ react: "19.3.1", reconciler: "0.34.0", scheduler: "0.28.0" });

export type Sha256 = string;
export type CanonicalResPath = string;
export type RootId = string;
export type RootInstance = string;
export type HostId = string;
export type ContainerId = string;
export type HostType = string;
export type NativeKey = Readonly<{ slot: number; revision: number }>;
export type RootState = "booting" | "running" | "quiescing" | "faulted" | "disposing" | "disposed";
export type HostPhase = "prepared" | "materialized" | "published" | "retiring" | "lost" | "freed";
export type NativePhase = "initial" | "safe" | "layout" | "passive" | "process" | "physics" | "input" | "cleanup" | "idle";
export type PublicationBarrier = "nativeApplied" | "layoutPublished" | "passiveSettled";
export type BuildMode = "development" | "production";
export type BuildState = "LOCKED" | "SNAPSHOTTED" | "EMITTED" | "MATERIALIZED" | "SCAN_IMPORT_PENDING" | "IMPORTS_VERIFIED" | "MANIFEST_SEALED" | "ACTIVE_COMMITTED" | "READY" | "FAILED";
export type EngineKind = "quickjs" | "v8" | "jsc" | "web";

export interface SourceLocation { source: CanonicalResPath; line: number; column: number; }
export interface CommitTicket { rootId: RootId; rootInstance: RootInstance; commitId: number; buildGeneration: string; }
export interface NativeAppliedReceipt { ticket: CommitTicket; barrier: "nativeApplied"; }
export interface LayoutPublishedReceipt { ticket: CommitTicket; barrier: "layoutPublished"; }
export interface CleanupReceipt { ticket: CommitTicket; barrier: "passiveSettled"; retirementBatch: string; roots: readonly HostId[]; passiveSequence: number; }
export interface RetirementBatch { id: string; ticket: CommitTicket; roots: readonly HostId[]; nativeKeys: readonly NativeKey[]; }
export interface PreparedHost { readonly type: HostType; readonly pendingProps: Readonly<Record<string, unknown>>; readonly pendingChildren: readonly unknown[]; }
export interface CommittedHost { readonly hostId: HostId; readonly nativeKey: NativeKey; readonly publishedCommit: number; readonly parent: HostId | ContainerId; readonly children: readonly HostId[]; readonly phase: "published" | "retiring" | "lost" | "freed"; }

export interface NativeInvalidation {
  rootId: RootId; rootInstance: RootInstance; hostId: HostId; nativeKey: NativeKey;
  reason: "external-free" | "expected-free" | "rebind" | "context-disposed";
  retirementBatch?: string;
}
export type NativeOpcode = "create" | "append" | "insert" | "move" | "detach" | "free" | "set" | "setOwner";
export interface NativeOperation {
  opId: string; ticket: CommitTicket; opcode: NativeOpcode; target?: NativeKey;
  parent?: NativeKey; child?: NativeKey; index?: number; type?: HostType; property?: string; value?: unknown;
}
export interface NativeOpResult {
  opId: string; status: "applied" | "rejected" | "lost";
  verification: "structure" | "stored-state" | "native-return" | "none";
  code?: string; message?: string; nativeKey?: NativeKey; value?: unknown;
}
export type EventOrigin = "external" | "controlledSetterEcho" | "user" | "engine";
export interface EventEnvelope {
  rootInstance: RootInstance; target: NativeKey; signal: string; origin: EventOrigin;
  observedCommit: number; sequence: number; payload: readonly unknown[];
}

export interface Vector2Value { readonly x: number; readonly y: number; }
export interface ColorValue { readonly r: number; readonly g: number; readonly b: number; readonly a: number; }
export interface AssetRef<T extends string = string> { readonly kind: "asset"; readonly id: string; readonly type: T; readonly scope?: "shared" | "instance"; }
export interface NodeReadHandle<K extends HostType = HostType> {
  readonly id: string; readonly type: K; readonly nativeKey: NativeKey;
  isValid(): boolean;
  read<T = unknown>(property: string): T;
}
export interface FrameCommands<K extends HostType = HostType, W extends string = string> extends NodeReadHandle<K> {
  readonly writableFields: readonly W[];
  command<T = unknown>(name: string, ...arguments_: readonly unknown[]): T;
}
export interface DispatchCapability {
  rootInstance: RootInstance; target: NativeKey; hookId: string; leaseId: string;
  leaseVersion: number; operationEpoch: number; dispatchToken: string; phase: "process" | "physics" | "input";
}
export interface PropertyLease {
  id: string; version: number; hostId: HostId; hookId: string; phase: "process" | "physics" | "input";
  canonicalFields: readonly string[];
}
export interface ReactVersions { react: string; reconciler: string; scheduler: string; }
export interface TargetCertification {
  sourceCommit: string; sourceDiffHash: Sha256; godotVersion: string;
  buildFlags: Readonly<Record<string, string | boolean | number>>;
  platform: string; arch: string; engine: EngineKind; godotSchemaHash: Sha256;
}
export interface CapabilityProfileV1 {
  id: string; version: 1; hosts: readonly string[]; codecs: readonly string[];
  resources: readonly string[]; features: Readonly<Record<string, boolean>>;
}
export interface ManifestEntry {
  id: string; module: string; exportName: string; script: CanonicalResPath; scene: CanonicalResPath;
  resourceHub?: CanonicalResPath; exportHub?: CanonicalResPath; startupAssets: readonly string[];
}
export interface ManifestModule { uri: CanonicalResPath; sha256: Sha256; dependencies: readonly string[]; kind: "view" | "vendor" | "template" | "model"; }
export interface ManifestResource { uri: CanonicalResPath; sha256: Sha256; type: string; dependencies: readonly string[]; importedArtifacts: readonly CanonicalResPath[]; }
export interface ManifestNativeScript { source: CanonicalResPath; output: CanonicalResPath; sha256: Sha256; dependencies: readonly string[]; }
export interface ManifestNativeScriptProfile { type: string; script: CanonicalResPath; schemaHash: Sha256; }
export interface ManifestArtifact { sha256: Sha256; owner: "compiler" | "native-importer"; kind: string; }
export interface RuntimeManifestV1 {
  schemaVersion: 1; generation: string; sourceSnapshotHash: Sha256; compilerVersion: string;
  runtimeAbi: string; nativeBridgeAbi: string; entryInterfaceHash: Sha256; mode: BuildMode;
  target: TargetCertification; react: ReactVersions; profile: { id: string; version: 1; hash: Sha256 };
  entries: Readonly<Record<string, ManifestEntry>>;
  modules: Readonly<Record<string, ManifestModule>>;
  resources: Readonly<Record<string, ManifestResource>>;
  nativeScripts: Readonly<Record<string, ManifestNativeScript>>;
  nativeScriptProfiles?: Readonly<Record<string, ManifestNativeScriptProfile>>;
  artifacts: Readonly<Record<CanonicalResPath, ManifestArtifact>>;
  sourceOrigins: Readonly<Record<CanonicalResPath, SourceLocation>>;
}
export interface ActiveDescriptorV1 { schemaVersion: 1; generation: string; manifestPath: CanonicalResPath; manifestSha256: Sha256; state: "READY"; }
export interface GenerationTicket { rootInstance: RootInstance; entryId: string; generation: string; manifestSha256: Sha256; runtimeAbi: string; nativeBridgeAbi: string; }
export interface TemplateNodeV1 {
  nodeId: string; nativeType: HostType; parentId: string | null; siblingOrder: number; name: string;
  initial: Readonly<Record<string, unknown>>; ownerId: string | null; source: SourceLocation;
}
export interface TemplateResourceV1 { resourceId: string; type: string; uri: CanonicalResPath; sha256: Sha256; dependencies: readonly string[]; sharingPolicy: "shared" | "instance"; }
export interface TemplatePlanV1 {
  schemaVersion: 1; assetId: string; source: CanonicalResPath; sourceHash: Sha256; snapshotHash: Sha256;
  /** T0: flat/shared; local-v1: flat/instance; structural-v1: expanded/shared. No combined structural/local profile. */
  profile: "template-t0" | "template-local-v1" | "template-structural-v1"; rootId: string; nodes: readonly TemplateNodeV1[]; resources: readonly TemplateResourceV1[];
}
export interface BootVerificationReportV1 {
  schemaVersion: 1; kind: "sdk-boot-verification-v1"; scope: "framework-boot-smoke";
  entryId: string; generation: string; rootInstance: RootInstance; runtimeAbi: string; nativeBridgeAbi: string;
  profile: string; layoutPublished: number;
  treeAudit: { matches: boolean; businessNodes: number };
  startupAssets: { requested: readonly string[]; ready: readonly string[]; failures: readonly string[] };
  unexpectedErrors: readonly string[];
}

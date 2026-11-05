import type { RuntimeManifestV1 } from '@godot-js/react/contracts';

export type BuildMode = 'development' | 'production';
export interface BrowserProjectConfig {
  schemaVersion: 1;
  entry: string;
  entries?: Record<string, { module: string; export?: string; props?: Record<string, unknown> }>;
  props?: Record<string, unknown>;
  dependencies: Record<string, string>;
  mode: BuildMode;
  profileId: string;
  runtimeRelease?: string;
  assets?: Record<string, { source: string; type: string }>;
}
export interface ProjectSnapshot {
  revision: string;
  sourceHash: string;
  files: ReadonlyMap<string, Uint8Array>;
  config: BrowserProjectConfig;
  lock?: unknown;
}
export interface ReleaseFile {
  path: string;
  url?: string;
  sha256: string;
  kind: string;
  sdkMode?: BuildMode;
  virtualPath?: string;
  encoding?: 'gzip';
  decodedSha256?: string;
  decodedBytes?: number;
}
export interface RuntimeRelease {
  schemaVersion: 1;
  id: string;
  runtimeRelease?: string;
  version: string;
  certified: boolean;
  engine: { godotVersion: string; engine: 'web'; engineTarget: string; threads: boolean; [key: string]: unknown };
  runtimeAbi: string;
  nativeBridgeAbi: string;
  react: { react: string; reconciler: string; scheduler: string };
  profiles: Record<string, { id: string; version: 1; hash: string }>;
  files: ReleaseFile[];
  specifiers: Record<string, string>;
  dependencies: Record<string, string>;
  sdkPackageRoot: string;
  typesRoot: string;
  libRoot: string;
  target?: RuntimeManifestV1['target'];
  [key: string]: unknown;
}
export interface Diagnostic {
  stage: string;
  code: string | number;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  length?: number;
  revision?: string;
  buildKey?: string;
}
export interface BuildArtifact {
  revision: string;
  buildKey: string;
  generation: string;
  runtimeRelease: string;
  manifest: RuntimeManifestV1;
  files: ReadonlyMap<string, Uint8Array>;
  pack: Uint8Array;
  diagnostics: Diagnostic[];
  resolutionHash: string;
}
export interface BuildIdentity {
  sourceHash: string;
  resolutionHash: string;
  runtimeRelease: string;
  sdkMode: BuildMode;
  profileId: string;
  compilerVersion: string;
  typescriptVersion: string;
  typeOptionsHash: string;
}
export class BrowserBuildError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(`${code}: ${message}`); this.name = 'BrowserBuildError'; }
}

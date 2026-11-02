import type { BuildMode, RuntimeManifestV1, TargetCertification } from "@godot-js/react/contracts";
import type { NativeInterfaceSchema } from "@godot-js/react/native-interfaces";

export interface EntryConfig { module: string; export?: string; props?: Record<string, unknown>; startupAssets?: string[]; }
export interface TemplateConfig { source: string; profile?: "template-t0" | "template-local-v1" | "template-structural-v1"; }
export interface AssetConfig { source: string; type?: string; }
export interface VerificationConfig { entry?: string; timeoutMs?: number; args?: string[]; }
export interface GodotReactConfig {
  entries: Record<string, string | EntryConfig>;
  templates?: Record<string, string | TemplateConfig>;
  assets?: Record<string, string | AssetConfig>;
  mode?: BuildMode;
  godot?: string;
  target?: Partial<TargetCertification>;
  tsconfig?: string;
  generatedDir?: string;
  runtimePackage?: string;
  verification?: VerificationConfig;
  exportPreset?: string;
  nativeInterfaces?: Record<string, NativeInterfaceSchema>;
  profileId?: string;
  nativeReport?: string;
}
export interface ProjectConfig extends GodotReactConfig { projectRoot: string; configFile: string; configHash:string;generatedDir: string; mode: BuildMode; }
export interface BuildOptions { projectRoot?: string; config?: string; mode?: BuildMode; importResources?: boolean; godot?: string; waitPublisherMs?:number; }
export interface BuildResult { generation: string; manifest: RuntimeManifestV1; manifestPath: string; activePath: string; diagnostics: string[]; }
export interface DoctorResult { ok: boolean; errors: string[]; warnings: string[]; generation?: string; manifest?: RuntimeManifestV1; }
export interface CommandResult { code: number; stdout: string; stderr: string; }

export class BuildError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(`${code}: ${message}`); this.name = "GodotReactBuildError"; }
}
export function fail(code: string, message: string, details?: unknown): never { throw new BuildError(code, message, details); }

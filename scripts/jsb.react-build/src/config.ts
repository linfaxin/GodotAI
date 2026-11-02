import path from "node:path";
import { pathToFileURL } from "node:url";
import {randomUUID} from "node:crypto";
import {promises as fs} from "node:fs";
import { exists, within,resolveExecutable,sha256 } from "./fs.js";
import { fail, type BuildOptions, type GodotReactConfig, type ProjectConfig } from "./types.js";
import {assertProjectPolicy} from "./project-policy.js";

const allowed = new Set(["entries", "templates", "assets", "mode", "godot", "target", "tsconfig", "generatedDir", "runtimePackage", "verification", "exportPreset", "nativeInterfaces", "profileId", "nativeReport"]);
export async function loadConfig(options: BuildOptions = {},policy:{setup?:boolean}={}): Promise<ProjectConfig> {
  const root = path.resolve(options.projectRoot ?? process.cwd());
  const file = options.config ? within(root, path.isAbsolute(options.config)?path.relative(root,options.config):options.config) : path.join(root, "godot-react.config.mjs");
  if (!await exists(file)) fail("E_CONFIG", `Missing ${file}`);
  const configHash=sha256(await fs.readFile(file));
  const module = await import(`${pathToFileURL(file).href}?godotReactConfig=${randomUUID()}`) as { default?: unknown };
  if(sha256(await fs.readFile(file))!==configHash)fail("E_SOURCE_CHANGED","Build configuration changed while loading");
  if (!module.default || typeof module.default !== "object" || Array.isArray(module.default)) fail("E_CONFIG", "Config default export must be an object");
  const config = module.default as GodotReactConfig;
  for (const key of Object.keys(config)) if (!allowed.has(key)) fail("E_CONFIG", `Unknown configuration option ${key}`);
  if (!config.entries || typeof config.entries !== "object" || Array.isArray(config.entries) || !Object.keys(config.entries).length) fail("E_CONFIG", "At least one entry is required");
  const ids = Object.keys(config.entries); for (const id of ids) if (!/^[a-z][a-z0-9_-]*$/.test(id)) fail("E_ENTRY_ID", `Invalid stable entry id ${id}`);
  const generatedDir = config.generatedDir ?? "generated/react"; within(root, generatedDir);
  if (generatedDir !== "generated/react") fail("E_CONFIG", "This native integration profile requires generatedDir=generated/react");
  const mode = options.mode ?? config.mode ?? "development"; if (mode !== "development" && mode !== "production") fail("E_CONFIG", `Invalid mode ${String(mode)}`);
  for (const [id, entry] of Object.entries(config.entries)) {
    const filename = typeof entry === "string" ? entry : entry.module;
    if (typeof filename !== "string" || !/\.[cm]?tsx?$/.test(filename)) fail("E_ENTRY", `Entry ${id} must name a TypeScript module`);
    within(root, filename);
  }
  const result = { ...config, projectRoot: root, configFile: file, configHash,generatedDir, mode, godot: options.godot ?? config.godot };
  if(result.godot)result.godot=await resolveExecutable(result.godot,root);
  await assertProjectPolicy(result,policy.setup);return result;
}
export const entryConfig = (config: ProjectConfig, id: string) => { const entry = config.entries[id]; if (!entry) fail("E_ENTRY", `Unknown entry ${id}`); return typeof entry === "string" ? { module: entry, export: "default", props: {}, startupAssets: [] } : { export: "default", props: {}, startupAssets: [], ...entry }; };

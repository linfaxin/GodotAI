import path from "node:path";
import { promises as fs } from "node:fs";
import { parseRuntimeManifest, validateActiveDescriptor,type RuntimeManifestV1 } from "@godot-js/react/contracts";
import { profileReference } from "@godot-js/react/schema";
import { loadConfig } from "./config.js";
import { exists, fromRes, readJson, sha256 } from "./fs.js";
import { generatedRoot, verifyArtifacts,verifySourceRecord } from "./publication.js";
import type { BuildOptions, DoctorResult } from "./types.js";

/** Inspect a sealed editor build. PCK boot validation is deliberately a separate operation. */
export async function doctorProject(options: BuildOptions = {}): Promise<DoctorResult> {
  const errors: string[] = [], warnings: string[] = [];
  let generation: string | undefined, manifest:RuntimeManifestV1|undefined;
  try {
    const config = await loadConfig(options), root = generatedRoot(config);
    if (await exists(path.join(root, ".publish-lock"))) errors.push("E_BUILD_BUSY: publication is in progress or needs recovery");
    const journal = await readJson<{ state?: string;generation?:string }>(path.join(root, "journal.json")).catch(() => undefined);
    if (journal?.state !== "READY") errors.push(`E_BUILD_NOT_READY: journal state ${journal?.state ?? "missing"}`);
    const active = validateActiveDescriptor(await readJson(path.join(root, "active.json"))); generation = active.generation;
    if(journal?.generation!==active.generation)errors.push("E_GENERATION_MISMATCH: journal and active descriptor differ");
    const bytes = await fs.readFile(fromRes(config.projectRoot, active.manifestPath));
    if (sha256(bytes) !== active.manifestSha256) errors.push("E_MANIFEST_HASH: active manifest digest mismatch");
    manifest = parseRuntimeManifest(bytes.toString("utf8"), { manifestUri: active.manifestPath, expectedGeneration: active.generation });
    const profile = profileReference(config.profileId);
    if (manifest.profile.id !== profile.id || manifest.profile.version !== profile.version || manifest.profile.hash !== profile.hash) errors.push("E_PROFILE_HASH: installed compiler schema differs from generation");
    errors.push(...await verifyArtifacts(config, manifest));
    errors.push(...await verifySourceRecord(config,manifest));
    if (manifest.target.sourceCommit === "unknown") warnings.push("Native source commit is not certified; set target from the native build report before release certification");
    if (manifest.target.godotVersion === "unknown") warnings.push("Native Godot version is unknown");
  } catch (error) { errors.push(String(error)); }
  return { ok: errors.length === 0, errors, warnings, ...(generation ? { generation } : {}), ...(manifest ? { manifest } : {}) };
}

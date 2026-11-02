import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
function option(name: string, fallback?: string): string | undefined { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing ${name}`); return args[i + 1]; }
const nativeReportPath = option("--native-report");
const godot = option("--godot", process.env.GODOT_BIN);
const output = option("--out");
const fixture = option("--fixture", "ui");
if (fixture !== "ui" && fixture !== "physics" && fixture !== "local-resources") throw new Error("--fixture must be ui, physics or local-resources");
const mode = option("--mode", "production");
if (mode !== "production" && mode !== "development") throw new Error("--mode must be development or production");
const entryId = fixture === "physics" ? "physics" : fixture === "local-resources" ? "local" : "app";
if (!godot || !output || !nativeReportPath) throw new Error("Usage: node scripts/test/react-integration.mts --godot <binary> --native-report <react-native-build.json> --out <independent directory> [--skip-package-build]");
const binary = realpathSync(resolve(godot));
const work = resolve(output);
if (work === moduleRoot || work.startsWith(`${moduleRoot}/`) || moduleRoot.startsWith(`${work}/`)) throw new Error("Integration output must be outside the module checkout");
mkdirSync(work, { recursive: true });
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const native = JSON.parse(readFileSync(resolve(nativeReportPath), "utf8"));
if (native.status !== "built" || native.binarySha256 !== sha256(readFileSync(binary))) throw new Error("Godot binary does not match a successful current-source native build report");
const stages: Record<string, unknown> = {};
// Each verifier owns its editor settings. Parallel headless editors must not
// compete for the optional V8 inspector's fixed default port.
const editorSettingsDirectory = join(work, "xdg-config", "godot");
const inheritedSettings = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "godot", "editor_settings-4.6.tres");
let settings = existsSync(inheritedSettings) ? readFileSync(inheritedSettings, "utf8") : '[gd_resource type="EditorSettings" format=3]\n\n[resource]\n';
const inspectorSetting = "GodotJS/debugger/editor_port = 0";
settings = /^GodotJS\/debugger\/editor_port\s*=.*$/m.test(settings) ? settings.replace(/^GodotJS\/debugger\/editor_port\s*=.*$/m, inspectorSetting) : `${settings}\n${inspectorSetting}\n`;
mkdirSync(editorSettingsDirectory, { recursive: true });
writeFileSync(join(editorSettingsDirectory, "editor_settings-4.6.tres"), settings);
process.env.XDG_CONFIG_HOME = dirname(editorSettingsDirectory);
stages.inspectorIsolation = { runtimeDebuggerPort: 0, editorDebuggerPort: 0, editorSettingsDirectory };
function inspectorErrors(text: string): string[] {
  return text.split(/\r?\n/).filter(line => /\[JSDebugger\].*\[LWS\].*(?:\bE:|bind ERROR)/.test(line));
}
function auditInspectorLogs(directory: string): string[] {
  const errors: string[] = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".godot"].includes(item.name)) continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) errors.push(...auditInspectorLogs(path));
    else if (item.isFile() && item.name.endsWith(".log")) errors.push(...inspectorErrors(readFileSync(path, "utf8")).map(line => `${path}: ${line}`));
  }
  return errors;
}
function sdkFingerprint(): string {
  const inputs: Record<string,string> = {};
  const visit = (directory: string) => { for (const item of readdirSync(join(moduleRoot,directory), {withFileTypes:true})) { const path = `${directory}/${item.name}`; if(item.isDirectory()) visit(path); else if(item.isFile()) inputs[path]=sha256(readFileSync(join(moduleRoot,path))); } };
  for(const root of ["scripts/jsb.react","scripts/jsb.react-build"]) {
    for(const directory of ["src","dist"]) visit(`${root}/${directory}`);
    for(const file of ["package.json","tsconfig.json","build.mjs"]) if(existsSync(join(moduleRoot,root,file))) inputs[`${root}/${file}`]=sha256(readFileSync(join(moduleRoot,root,file)));
  }
  inputs["pnpm-lock.yaml"]=sha256(readFileSync(join(moduleRoot,"pnpm-lock.yaml")));
  return sha256(JSON.stringify(Object.fromEntries(Object.entries(inputs).sort(([a],[b])=>a.localeCompare(b)))));
}
function command(name: string, executable: string, commandArgs: string[], cwd: string, timeout = 120_000) {
  const result = spawnSync(executable, commandArgs, { cwd, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GODOT_SILENCE_ROOT_WARNING: "1" } });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const log = join(work, `${name}.log`); writeFileSync(log, text);
  const summary = { exitCode: result.status, error: result.error?.message, log };
  stages[name] = summary;
  if (result.status !== 0 || result.error) throw new Error(`${name} failed; inspect ${log}`);
  if (inspectorErrors(text).length) throw new Error(`${name} emitted V8 inspector transport errors; inspect ${log}`);
  return { ...summary, text };
}
function packPaths(file: string): string[] {
  const bytes = readFileSync(file);
  if (bytes.readUInt32LE(0) !== 0x43504447 || bytes.readUInt32LE(4) !== 3) throw new Error("PCK audit currently requires Godot PCK version 3");
  let offset = Number(bytes.readBigUInt64LE(32));
  const count = bytes.readUInt32LE(offset); offset += 4;
  const paths: string[] = [];
  for (let i = 0; i < count; i++) { const n = bytes.readUInt32LE(offset); offset += 4; paths.push(bytes.toString("utf8", offset, offset + n).replace(/\0+$/, "")); offset += n + 36; }
  return paths;
}
function jsonLines(text: string, marker: string): any[] {
  return text.split(/\r?\n/).filter(line => line.includes(marker)).map(line => JSON.parse(line.slice(line.indexOf(marker) + marker.length).trim()));
}
function assessRuntime(name: string, text: string, generation: string) {
  const errors = text.split(/\r?\n/).filter(line => /SCRIPT ERROR:|^ERROR:|\[jsb\]\[Error\]|Failed to call:|^Uncaught\s|GODOT_REACT_(?:FIXTURE_FAILED|BOOT_FAILED|CLEANUP_FAILED|RUNTIME_(?:ERROR|FAILED))/.test(line)).concat(inspectorErrors(text));
  const behavior = jsonLines(text, fixture === "physics" ? "GODOT_REACT_PHYSICS_BEHAVIOR_OK " : fixture === "local-resources" ? "GODOT_REACT_LOCAL_RESOURCES_NATIVE_OK " : "GODOT_REACT_FIXTURE_BEHAVIOR_OK ");
  const boot = jsonLines(text, "GODOT_REACT_BOOT_REPORT ");
  const cleanup = jsonLines(text, "GODOT_REACT_FIXTURE_CLEANUP ");
  const toggles = jsonLines(text, "GODOT_REACT_FIXTURE_TOGGLE ");
  const inputDtos = jsonLines(text, "GODOT_REACT_FIXTURE_INPUT_DTO ");
  const nativePhysics = fixture === "physics" ? jsonLines(text, "GODOT_REACT_PHYSICS_NATIVE_OK ") : [];
  const b = behavior[0], r = boot[0], p = nativePhysics[0];
  const bootValid = boot.length === 1 && r.kind === "sdk-boot-verification-v1" && r.scope === "framework-boot-smoke" && r.generation === generation && r.entryId === entryId && r.profile === (fixture === "physics" ? "behavior-physics-v1" : "core-ui-v1") && r.layoutPublished > 0 && r.treeAudit?.matches === true && r.treeAudit?.businessNodes === (fixture === "physics" ? 5 : fixture === "local-resources" ? 6 : 15) && r.startupAssets?.failures?.length === 0 && r.unexpectedErrors?.length === 0;
  const behaviorValid = fixture === "physics"
    ? behavior.length === 1 && b.realMoveAndSlide === true && b.collisions > 5 && b.settled >= 10 && b.position.y >= 120 && b.position.y <= 130 && nativePhysics.length === 1 && p.onFloor === true && p.sawFall === true && r?.startupAssets?.ready?.includes("floorShape") && r?.startupAssets?.ready?.includes("actorShape") && text.includes("GODOT_REACT_PHYSICS_STALE_TOKEN_OK")
    : fixture === "local-resources"
    ? behavior.length === 1 && b.resets === 20 && b.sameInstanceAliases === true && b.crossInstanceIsolation === true && b.localSceneIdentity === true && b.owners === true && b.sourceCloned === true && b.persistentSibling === true && r?.startupAssets?.ready?.length > 0
    : behavior.length === 1 && b.businessNodes === 15 && b.nativeGuiInput === true && b.template === true && b.propsPreserveState === true && b.keyResetsOneScene === true && b.context === true && b.stressResets === 100 && b.nativeNodePlateau === true && b.controlledButton === true && b.uncontrolledButton === true && toggles.length === 1 && toggles[0].name === "Other" && toggles[0].checked === true && inputDtos.length === 1 && inputDtos[0].type === "InputEventKey" && inputDtos[0].pressed === true && inputDtos[0].keycode > 0 && inputDtos[0].frozen === true && inputDtos[0].noNativeMethods === true && r?.startupAssets?.ready?.includes("marker") && cleanup.filter(x => x.name === "Main" && x.valid === true).length >= 101 && cleanup.every(x => x.valid === true);
  const strictModeReplay = fixture === "ui" && name === "direct" && mode === "development"
    ? cleanup.some(x => x.name === "Main" && x.valid === true && x.text === "ctx-A/Main:1") && cleanup.some(x => x.name === "Other" && x.valid === true && x.text === "ctx-A/Other:10") : undefined;
  const passed = errors.length === 0 && bootValid && behaviorValid && strictModeReplay !== false;
  const summary = { passed, strictModeReplay, behavior, nativePhysics, boot, cleanup, toggles, inputDtos, errors }; stages[`${name}Assertions`] = summary;
  if (!passed) throw new Error(`${name} lacked a valid boot report, cleanup receipt, behavior proof, or clean runtime log`);
}
function verifyForeignSceneRejection(project: string, driver: string) {
  const result = spawnSync(binary, ["--headless", "--fixed-fps", "60", "--path", project, "--script", driver, "--", "--inject-foreign-node"], { cwd: work, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GODOT_SILENCE_ROOT_WARNING: "1" } });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`, log = join(work, "foreign-scene-negative.log"); writeFileSync(log, text);
  const passed = result.status !== null && result.status !== 0 && !result.error && inspectorErrors(text).length === 0 && text.includes("GODOT_REACT_FOREIGN_NODE_INJECTED") && /E_FOREIGN_MUTATION[^\n]*unregistered public Node/.test(text) && !text.includes("GODOT_REACT_FIXTURE_BEHAVIOR_OK");
  stages.foreignSceneRejection = { passed, exitCode: result.status, error: result.error?.message, log };
  if (!passed) throw new Error(`External native SceneTree sibling was not rejected: ${log}`);
}
function verifyTsxSourceMap(project: string, driver: string) {
  const result = spawnSync(binary, ["--headless", "--fixed-fps", "60", "--path", project, "--script", driver, "--", "--trigger-tsx-error"], { cwd: work, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GODOT_SILENCE_ROOT_WARNING: "1" } });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`, log = join(work, "tsx-source-map-negative.log"); writeFileSync(log, text);
  const expectedLine = readFileSync(join(project, "src/App.tsx"), "utf8").split(/\r?\n/).findIndex(line => line.includes('throw new Error("GODOT_REACT_SOURCE_MAP_PROBE")')) + 1;
  const mappedFrame = new RegExp(`(?:res:\\/\\/)?src\\/App\\.tsx:${expectedLine}(?::\\d+)?(?:\\D|$)`);
  const passed = expectedLine > 0 && result.status !== null && result.status !== 0 && !result.error && inspectorErrors(text).length === 0 && text.includes("GODOT_REACT_SOURCE_MAP_TRIGGERED") && text.includes("GODOT_REACT_SOURCE_MAP_PROBE") && mappedFrame.test(text) && !text.includes("GODOT_REACT_FIXTURE_BEHAVIOR_OK");
  stages.tsxSourceMap = { passed, expectedSource: "res://src/App.tsx", expectedLine, exitCode: result.status, error: result.error?.message, log };
  if (!passed) throw new Error(`Actual TSX exception did not map to its original throw line: ${log}`);
}

let passed = false;
let sdkSourceHash: string | undefined;
try {
  if (!args.includes("--skip-package-build")) {
    command("runtime-build", "pnpm", ["--filter", "@godot-js/react", "build"], moduleRoot);
    command("compiler-build", "pnpm", ["--filter", "@godot-js/react-build", "build"], moduleRoot);
  }
  sdkSourceHash = sdkFingerprint();
  const project = join(work, "project"); rmSync(project, { recursive: true, force: true });
  const fixtureRoot = join(moduleRoot, fixture === "physics" ? "tests/react/physics" : fixture === "local-resources" ? "tests/react/local-resources" : "tests/react/fixture");
  cpSync(fixtureRoot, project, { recursive: true });
  const link = (name: string, target: string) => { const path = join(project, "node_modules", name); mkdirSync(dirname(path), { recursive: true }); symlinkSync(realpathSync(target), path, "dir"); };
  const runtime = join(moduleRoot, "scripts/jsb.react");
  link("@godot-js/react", runtime);
  link("react", join(runtime, "node_modules/react"));
  link("@types/react", join(runtime, "node_modules/@types/react"));
  const configFile = join(project, "godot-react.config.mjs");
  const nativeFlags = { ...Object.fromEntries(native.flags.filter((x: string) => x.includes("=")).map((x: string) => x.split("="))), ...(native.godotBuildRecipe ? {godot_build_recipe: native.godotBuildRecipe.kind, godot_build_recipe_sha256: native.godotBuildRecipeSha256} : {}) };
  writeFileSync(configFile, readFileSync(configFile, "utf8").replace(/mode:\s*["'](?:production|development)["']/, `mode: ${JSON.stringify(mode)}`).replace("export default {", `export default {\n  godot: ${JSON.stringify(binary)},\n  target: ${JSON.stringify({ sourceCommit: native.sourceCommit, sourceDiffHash: native.sourceSnapshotHash, buildFlags: nativeFlags, engine: native.engine === "qjs" ? "quickjs" : "v8" })},`));
  const api = await import(pathToFileURL(join(moduleRoot, "scripts/jsb.react-build/dist/index.js")).href);
  const build = await api.buildProject({ projectRoot: project, godot: binary, importResources: true, mode });
  stages.build = build;
  const doctor = await api.doctorProject({ projectRoot: project, godot: binary }); stages.doctor = doctor;
  if (!doctor.ok) throw new Error(`Doctor rejected the sealed generation: ${JSON.stringify(doctor.errors)}`);
  let active = JSON.parse(readFileSync(join(project, "generated/react/active.json"), "utf8"));
  let manifest = JSON.parse(readFileSync(join(project, active.manifestPath.slice(6)), "utf8"));
  stages.active = active;
  const driver = join(fixtureRoot, "verify.gd");
  const direct = command("direct", binary, ["--headless", "--fixed-fps", "60", "--path", project, "--script", driver], work);
  assessRuntime("direct", direct.text, manifest.generation);
  if (fixture === "ui") { verifyForeignSceneRejection(project, driver); verifyTsxSourceMap(project, driver); }
  const pack = join(work, "react-conformance.pck");
  stages.export = await api.exportProject({ projectRoot: project, godot: binary, output: pack, entry: entryId });
  active = JSON.parse(readFileSync(join(project, "generated/react/active.json"), "utf8"));
  manifest = JSON.parse(readFileSync(join(project, active.manifestPath.slice(6)), "utf8"));
  if (manifest.mode !== "production") throw new Error("Official export did not publish production mode");
  const entry = manifest.entries[entryId];
  const selected = [entry.scene, entry.exportHub];
  if (!existsSync(pack) || statSync(pack).size === 0) throw new Error("Export succeeded without a nonempty PCK");
  const paths = packPaths(pack);
  if (paths.some(x => /(?:^|\/)templates\/Panel\.tscn$/.test(x))) throw new Error("Read-only TSCN template leaked into runtime PCK");
  const nativeOutput = Object.values(manifest.nativeScripts).find((x: any) => x.source === entry.script) as { output: string } | undefined;
  if (!nativeOutput) throw new Error("Entry has no generated NativeScript descriptor");
  for (const uri of [active.manifestPath, "res://generated/react/active.json", nativeOutput.output]) if (!paths.includes(uri.slice(6))) throw new Error(`PCK lacks required sealed artifact ${uri}`);
  for (const resource of Object.values(manifest.resources) as { uri: string }[]) if (!paths.includes(resource.uri.slice(6)) && !paths.includes(`${resource.uri.slice(6)}.remap`)) throw new Error(`PCK lacks native resource or its Godot remap ${resource.uri}`);
  stages.packAudit = { selected, includeFilter: "", bytes: statSync(pack).size, paths };
  const empty = join(work, "empty"); rmSync(empty, { recursive: true, force: true }); mkdirSync(empty);
  const played = command("pck", binary, ["--headless", "--fixed-fps", "60", "--main-pack", pack, "--script", driver], empty);
  assessRuntime("pck", played.text, manifest.generation);
  const inspectorDiagnostics = auditInspectorLogs(work);
  stages.inspectorLogAudit = { passed: inspectorDiagnostics.length === 0, errors: inspectorDiagnostics };
  if (inspectorDiagnostics.length) throw new Error("V8 inspector transport errors were present in an import or runtime log");
  if(sdkFingerprint()!==sdkSourceHash) throw new Error("SDK sources or built packages changed during integration; rerun the final frozen implementation");
  passed = true;
} catch (error) {
  stages.error = error instanceof Error ? error.stack : String(error);
  if (error && typeof error === "object" && "details" in error) stages.errorDetails = error.details;
}
const report = { schemaVersion: 1, passed, fixture, mode, exportMode: "production", sourceCommit: native.sourceCommit, sourceSnapshotHash: native.sourceSnapshotHash, sdkSourceHash, binarySha256: native.binarySha256, engine: native.engine, nativeBuildReport: resolve(nativeReportPath), godotBuildRecipe: native.godotBuildRecipe ? {kind: native.godotBuildRecipe.kind, originalGodotVersion: native.godotBuildRecipe.originalGodotVersion, patches: native.godotBuildRecipe.patches.map((x: any) => ({path: x.path, originalSha256: x.originalSha256, patchedSha256: x.patchedSha256}))} : undefined, stages };
const file = join(work, "react-integration.json"); writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed, report: file, error: stages.error }, null, 2));
if (!passed) process.exitCode = 1;

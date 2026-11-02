import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import ts from "typescript";
import { assertBootSucceeded, validateBootReport, type BootVerificationReportV1 } from "@godot-js/react/contracts";
import { loadConfig } from "./config.js";
import { buildProject } from "./compiler.js";
import { doctorProject } from "./doctor.js";
import { command, exists, fromRes, sha256, write } from "./fs.js";
import { fail, type BuildOptions, type CommandResult } from "./types.js";
import { acquireRunLease } from "./publication.js";
import {assertSourceCertified} from "./native-target.js";
import {startManagedPreview} from "./preview.js";

export function readBootReports(output: string): BootVerificationReportV1[] {
  const reports: BootVerificationReportV1[] = [];
  for (const line of output.split(/\r?\n/)) {
    const marker = "GODOT_REACT_BOOT_REPORT ", at = line.indexOf(marker);
    if (at >= 0) reports.push(validateBootReport(JSON.parse(line.slice(at + marker.length))));
  }
  return reports;
}
export function assertCleanExecution(result: CommandResult, expected: { generation: string; entryId: string }): BootVerificationReportV1 {
  const output = result.stdout + result.stderr;
  if (result.code !== 0 || /SCRIPT ERROR|Parse Error|^ERROR:|GODOT_REACT_(?:BOOT_FAILED|RUNTIME_ERROR|RUNTIME_FAILED|CLEANUP_FAILED)|\[jsb\]\[Error\]/im.test(output)) fail("E_BOOT_FAILED", "Native runtime execution failed", result);
  const reports = readBootReports(output), report = reports.find(r => r.generation === expected.generation && r.entryId === expected.entryId);
  if (!report) fail("E_BOOT_REPORT_MISSING", "No matching structured SDK BootReport was produced", result);
  if(reports.length!==1)fail("E_BOOT_REPORT_AMBIGUOUS","Expected exactly one SDK application root BootReport",reports);
  assertBootSucceeded(report);
  return report;
}
export function readBusinessVerification(output:string,expected:{generation:string;entryId:string}):{entryId:string;generation:string;result:unknown}{
  const reports:unknown[]=[],marker="GODOT_REACT_BUSINESS_VERIFIED ";
  for(const line of output.split(/\r?\n/)){const at=line.indexOf(marker);if(at<0)continue;try{reports.push(JSON.parse(line.slice(at+marker.length)));}catch{fail("E_BUSINESS_VERIFICATION","Malformed structured business verification report",line);}}
  const report=reports[0] as {entryId?:unknown;generation?:unknown;result?:unknown}|undefined;
  if(reports.length!==1||!report||typeof report!=="object"||Array.isArray(report)||Object.keys(report).sort().join(",")!=="entryId,generation,result"||report.entryId!==expected.entryId||report.generation!==expected.generation)fail("E_BUSINESS_VERIFICATION","Expected one structured business report bound to the selected entry and generation",reports);
  return report as {entryId:string;generation:string;result:unknown};
}
export async function previewProject(options: BuildOptions & { entry?: string; verify?: boolean; headless?:boolean;signal?:AbortSignal } = {}) {
  const config = await loadConfig(options);
  if (!config.godot) fail("E_GODOT_REQUIRED", "Set godot in configuration or pass --godot");
  const build = await buildProject(options), id = options.entry ?? Object.keys(build.manifest.entries)[0], entry = build.manifest.entries[id];
  if (!entry) fail("E_ENTRY", `Unknown entry ${id}`);
  if(!options.verify){
    const preview=await startManagedPreview(config,build.generation,id,{headless:options.headless});
    const cancel=()=>{void preview.stop().catch(()=>{});};
    options.signal?.addEventListener("abort",cancel,{once:true});if(options.signal?.aborted)cancel();
    try{return {...await preview.result,generation:build.generation};}
    finally{options.signal?.removeEventListener("abort",cancel);}
  }
  const args = [...(options.verify || options.headless ? ["--headless"] : []), "--path", config.projectRoot, entry.scene];
  if (options.verify) args.push("--", "--godot-react-verify");
  const lease=await acquireRunLease(config,build.generation,"@godot-react/verification");
  let result:CommandResult;
  try{result=await lease.command(config.godot, args, { cwd: config.projectRoot, timeoutMs: config.verification?.timeoutMs ?? 30_000,signal:options.signal });}
  finally{await lease.release();}
  return { ...result, generation: build.generation, ...(options.verify ? { report: assertCleanExecution(result, { generation: build.generation, entryId: id }) } : {}) };
}

/** Append a dedicated selected-scenes preset, then restore the exact author file. */
export async function exportProject(options: BuildOptions & { output: string; preset?: string; entry?: string } ) {
  if(!options.output.endsWith(".pck"))fail("E_ARGUMENT","Verified export output must have a .pck extension");
  const config = await loadConfig(options); if (!config.godot) fail("E_GODOT_REQUIRED", "Export requires a Godot executable");
  const build = await buildProject({ ...options, mode: "production" });
  assertSourceCertified(build.manifest.target);
  const certificateUri=Object.entries(build.manifest.artifacts).find(([,artifact])=>artifact.kind==="native-build-report")?.[0];
  if(!certificateUri)fail("E_NATIVE_TARGET_UNCERTIFIED","Official export requires a successful source-build report bound to the selected binary SHA; set nativeReport or place react-native-build.json beside the binary or in its parent directory");
  const certificate=JSON.parse(await fs.readFile(fromRes(config.projectRoot,certificateUri),"utf8")) as {binarySha256:string};
  if(sha256(await fs.readFile(config.godot))!==certificate.binarySha256)fail("E_NATIVE_TARGET_UNCERTIFIED","Selected binary no longer matches its source-build certificate");
  const doctor = await doctorProject(options); if (!doctor.ok) fail("E_EXPORT_PREFLIGHT", "Build failed export preflight", doctor);
  const id = options.entry ?? Object.keys(build.manifest.entries)[0], entry = build.manifest.entries[id]; if (!entry) fail("E_ENTRY", `Unknown entry ${id}`);
  const output = path.resolve(config.projectRoot, options.output), presetFile = path.join(config.projectRoot, "export_presets.cfg");
  const lease = await acquireRunLease(config, build.generation);
  let previous = "", workspace: string | undefined, temporaryPreset = false;
  let preset = options.preset ?? config.exportPreset;
  try {
   previous = await fs.readFile(presetFile, "utf8").catch(() => "");
   if (!preset) {
    const indices = [...previous.matchAll(/\[preset\.(\d+)\]/g)].map(m => Number(m[1])); const index = Math.max(-1, ...indices) + 1;
    preset = `Godot React verified ${build.generation}`; temporaryPreset = true;
    const roots = [entry.scene, entry.exportHub!].map(x => JSON.stringify(x)).join(", ");
    const architecture=({x64:"x86_64",ia32:"x86_32",aarch64:"arm64",arm:"arm32"} as Record<string,string>)[build.manifest.target.arch]??build.manifest.target.arch;
    if(!["x86_64","x86_32","arm64","arm32","rv64","ppc64","loongarch64"].includes(architecture))fail("E_EXPORT_ARCH",`No certified default Linux export architecture for ${build.manifest.target.arch}; select an explicit export preset`);
    await write(presetFile, `${previous}\n[preset.${index}]\nname=${JSON.stringify(preset)}\nplatform="Linux"\nrunnable=true\nadvanced_options=false\nexport_filter="scenes"\nexport_files=PackedStringArray(${roots})\ninclude_filter=""\nexclude_filter=""\nexport_path=""\n[preset.${index}.options]\nbinary_format/architecture=${JSON.stringify(architecture)}\nbinary_format/embed_pck=false\n`);
   }
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "godot-react-export-")); const temporaryPack = path.join(workspace, "candidate.pck");
    const exported = await lease.command(config.godot, ["--headless", "--path", config.projectRoot, "--export-pack", preset!, temporaryPack], { cwd: config.projectRoot, timeoutMs: 120_000 });
    if (exported.code !== 0 || !await exists(temporaryPack) || /SCRIPT ERROR|Parse Error|^ERROR:|\[jsb\]\[Error\]/im.test(exported.stdout + exported.stderr)) fail("E_EXPORT_FAILED", "Temporary PCK export failed", exported);
    // Launch without the project source tree, proving the exported dependency closure.
    const isolated = path.join(workspace, "empty"); await fs.mkdir(isolated);
    const boot = await lease.command(config.godot, ["--headless", "--path", isolated, "--main-pack", temporaryPack, entry.scene, "--", "--godot-react-verify"], { cwd: isolated, timeoutMs: config.verification?.timeoutMs ?? 30_000 });
    const report = assertCleanExecution(boot, { generation: build.generation, entryId: id });
    if (config.verification?.entry) {
      const verified = await lease.command(config.godot, ["--headless", "--path", isolated, "--main-pack", temporaryPack, entry.scene, "--", "--godot-react-business-verify", ...(config.verification.args ?? [])], { cwd: isolated, timeoutMs: config.verification.timeoutMs ?? 30_000 });
      assertCleanExecution(verified, { generation: build.generation, entryId: id });
      readBusinessVerification(verified.stdout,{generation:build.generation,entryId:id});
    }
    await fs.mkdir(path.dirname(output), { recursive: true }); const publish = `${output}.${process.pid}.tmp`; await fs.copyFile(temporaryPack, publish); await fs.rename(publish, output);
    return { output, generation: build.generation, sha256: sha256(await fs.readFile(output)), report };
  } finally {
    try { if (temporaryPreset) { if (previous) await write(presetFile, previous); else await fs.rm(presetFile, { force: true }); } }
    finally { try { if (workspace) await fs.rm(workspace, { recursive: true, force: true }); } finally { await lease.release(); } }
  }
}

export async function setupProject(options: BuildOptions = {}): Promise<{ project: string; entries: string[] }> {
  const config = await loadConfig(options,{setup:true}), file = path.join(config.projectRoot, "project.godot");
  let text = await fs.readFile(file, "utf8");
  const section = /^\[godotjs\]\s*$/m.exec(text);
  if (section) {
    const begin = section.index + section[0].length, end = text.indexOf("\n[", begin), rangeEnd = end < 0 ? text.length : end;
    const body = text.slice(begin, rangeEnd); text = text.slice(0, begin) + (/(?:^|\n)react\/enabled=/.test(body) ? body.replace(/react\/enabled=[^\n]*/, "react/enabled=true") : `${body}\nreact/enabled=true\n`) + text.slice(rangeEnd);
  } else text += "\n[godotjs]\nreact/enabled=true\n";
  const application=/^\[application\][ \t]*$/m.exec(text), scene=`run/main_scene=${JSON.stringify(`res://${config.generatedDir}/scenes/${Object.keys(config.entries)[0]}.tscn`)}`;
  if(application){const begin=application.index+application[0].length,end=text.indexOf("\n[",begin),last=end<0?text.length:end,body=text.slice(begin,last);text=text.slice(0,begin)+(/(?:^|\n)run\/main_scene=/.test(body)?body.replace(/run\/main_scene=[^\n]*/,scene):`${body}\n${scene}\n`)+text.slice(last);}else text+=`\n[application]\n${scene}\n`;
  await write(file, text);
  // Generate dedicated template declarations first; the compiler uses the same Program for validation.
  const { generateProjectTypes } = await import("./compiler.js"); await generateProjectTypes(options);
  const tsconfigFile = path.join(config.projectRoot, config.tsconfig ?? "tsconfig.json");
  const parsed = await exists(tsconfigFile) ? ts.readConfigFile(tsconfigFile, ts.sys.readFile) : { config: {} };
  if (parsed.error) fail("E_TYPESCRIPT_CONFIG", "Cannot update invalid tsconfig.json");
  const settings = parsed.config as {compilerOptions?: {paths?:Record<string,string[]>};include?:string[]};
  settings.compilerOptions ??= {}; settings.compilerOptions.paths ??= {}; settings.compilerOptions.paths["@project/react-templates/*"] = [`./${config.generatedDir}/templates/*`];
  await write(tsconfigFile, `${JSON.stringify(settings, null, 2)}\n`);
  return { project: file, entries: Object.keys(config.entries) };
}

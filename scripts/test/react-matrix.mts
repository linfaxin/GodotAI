import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
function option(flag: string, fallback?: string): string | undefined { const i = args.indexOf(flag); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing ${flag}`); return args[i + 1]; }
const output = option("--out"), qjsFile = option("--qjs-report"), v8File = option("--v8-report");
if (!output || !qjsFile || !v8File) throw new Error("Usage: node scripts/test/react-matrix.mts --qjs-report <native build JSON> --v8-report <native build JSON> --out <independent directory> [--jobs 2] [--skip-package-build] [--collect-only]");
const work = resolve(output);
if (work === moduleRoot || work.startsWith(`${moduleRoot}/`) || moduleRoot.startsWith(`${work}/`)) throw new Error("Matrix output must be outside the checkout");
mkdirSync(work, { recursive: true });
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const excluded = new Set([".git", "node_modules", ".godot", "__pycache__"]);
const currentInputs = ["SCsub", "config.py", "register_types.cpp", "register_types.h", "jsb.config.h", "jsb.h"].filter(path => existsSync(join(moduleRoot, path)));
function collect(directory: string): void {
  for (const item of readdirSync(join(moduleRoot, directory), { withFileTypes: true })) {
    if (excluded.has(item.name)) continue;
    const path = `${directory}/${item.name}`;
    if (item.isDirectory()) collect(path);
    else if (item.isFile() && /\.(?:h|hpp|cpp|c|py)$/.test(path)) currentInputs.push(path);
  }
}
for (const directory of ["bridge", "compat", "impl", "internal", "weaver", "weaver-editor", "tests", "quickjs", "quickjs-ng"]) if (existsSync(join(moduleRoot, directory))) collect(directory);
const targets = [{ engine: "qjs", path: resolve(qjsFile) }, { engine: "v8", path: resolve(v8File) }].map(t => ({ ...t, report: JSON.parse(readFileSync(t.path, "utf8")) }));
for (const target of targets) {
  const r = target.report;
  if (r.status !== "built" || r.engine !== target.engine || sha256(readFileSync(r.binary)) !== r.binarySha256) throw new Error(`Uncertified native target ${target.path}`);
  if (JSON.stringify(Object.keys(r.inputs).sort()) !== JSON.stringify([...currentInputs].sort())) throw new Error(`Native input files were added or removed since ${target.engine} was built`);
  for (const [path, hash] of Object.entries(r.inputs) as [string, string][]) {
    const file = join(moduleRoot, path);
    if (!existsSync(file) || sha256(readFileSync(file)) !== hash) throw new Error(`Native source changed since ${target.engine} was built: ${path}`);
  }
}
if (targets[0].report.sourceCommit !== targets[1].report.sourceCommit || targets[0].report.sourceSnapshotHash !== targets[1].report.sourceSnapshotHash || targets[0].report.godotBuildRecipeSha256 !== targets[1].report.godotBuildRecipeSha256) throw new Error("Both engines must certify the same native source and Godot build recipe");
const collectOnly = args.includes("--collect-only");
function execute(label: string, executable: string, commandArgs: string[]): Promise<void> {
  return new Promise((done, reject) => {
    const log = createWriteStream(join(work, `${label}.log`));
    const child = spawn(executable, commandArgs, { cwd: moduleRoot, env: { ...process.env, GODOT_SILENCE_ROOT_WARNING: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.once("error", error => { log.end(); reject(error); });
    child.once("close", (code, signal) => { log.end(); code === 0 ? done() : reject(new Error(`${label}: exit=${code}, signal=${signal}; inspect ${join(work, `${label}.log`)}`)); });
  });
}
const jobs: { label: string; path: string; engine: string; mode?: string; fixture?: string; args: string[] }[] = [];
for (const t of targets) {
  const label = `native-${t.engine}`, dir = join(work, label);
  jobs.push({ label, path: join(dir, "react-native-tests.json"), engine: t.engine, args: [join(moduleRoot, "scripts/test/react-native-test.mts"), "--native-report", t.path, "--out", dir] });
  for (const [name, fixture] of [["ui", "ui"], ["physics", "physics"], ["local", "local-resources"]]) for (const mode of ["production", "development"]) {
    const label = `${name}-${t.engine}-${mode}`, dir = join(work, label);
    jobs.push({ label, path: join(dir, "react-integration.json"), engine: t.engine, mode, fixture,
      args: [join(moduleRoot, "scripts/test/react-integration.mts"), "--godot", t.report.binary, "--native-report", t.path, "--out", dir, "--fixture", fixture, "--mode", mode, "--skip-package-build"] });
  }
}
const results: Record<string, unknown>[] = [];
const sdkSourceHashes = new Set<string>();
let failure: string | undefined;
try {
  if (!collectOnly && !args.includes("--skip-package-build")) {
    await execute("runtime-build", "pnpm", ["--filter", "@godot-js/react", "build"]);
    await execute("compiler-build", "pnpm", ["--filter", "@godot-js/react-build", "build"]);
  }
  const concurrency = Number(option("--jobs", "1"));
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("--jobs must be between 1 and 8");
  let next = 0;
  await Promise.all(Array.from({ length: collectOnly ? 1 : concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        if (!collectOnly) await execute(job.label, process.execPath, job.args);
        const report = JSON.parse(readFileSync(job.path, "utf8")), native = targets.find(t => t.engine === job.engine)!.report;
        if (!report.passed || report.engine !== job.engine || report.sourceSnapshotHash !== native.sourceSnapshotHash || report.binarySha256 !== native.binarySha256 || job.mode && (report.mode !== job.mode || report.fixture !== job.fixture)) throw new Error("Result does not match the expected source/binary/fixture/mode tuple");
        if(job.fixture){if(!/^[0-9a-f]{64}$/.test(report.sdkSourceHash??""))throw new Error("Integration report has no SDK source/build fingerprint");sdkSourceHashes.add(report.sdkSourceHash);}
        results.push({ label: job.label, passed: true, report: job.path });
      } catch (error) { results.push({ label: job.label, passed: false, report: job.path, error: String(error) }); }
    }
  }));
} catch (error) { failure = String(error); }
try {
  currentInputs.splice(0,currentInputs.length,...["SCsub", "config.py", "register_types.cpp", "register_types.h", "jsb.config.h", "jsb.h"].filter(path => existsSync(join(moduleRoot,path))));
  for(const directory of ["bridge", "compat", "impl", "internal", "weaver", "weaver-editor", "tests", "quickjs", "quickjs-ng"])if(existsSync(join(moduleRoot,directory)))collect(directory);
  for(const target of targets){
    if(sha256(readFileSync(target.report.binary))!==target.report.binarySha256)throw new Error(`Native ${target.engine} binary changed during certification`);
    if(JSON.stringify(Object.keys(target.report.inputs).sort())!==JSON.stringify([...currentInputs].sort()))throw new Error("Native input set changed during certification");
    for(const [path,hash]of Object.entries(target.report.inputs) as [string,string][])if(sha256(readFileSync(join(moduleRoot,path)))!==hash)throw new Error(`Native input changed during certification: ${path}`);
  }
}catch(error){failure=String(error);}
const passed = !failure && sdkSourceHashes.size === 1 && results.length === jobs.length && results.every(x => x.passed);
const report = { schemaVersion: 1, passed, execution: collectOnly ? "collected-existing-results" : "fresh-execution", sourceCommit: targets[0].report.sourceCommit, sourceSnapshotHash: targets[0].report.sourceSnapshotHash, sdkSourceHashes:[...sdkSourceHashes], godotBuildRecipeSha256: targets[0].report.godotBuildRecipeSha256, targets: targets.map(t => ({engine:t.engine,nativeBuildReport:t.path,binarySha256:t.report.binarySha256})), results: results.sort((a,b) => String(a.label).localeCompare(String(b.label))), ...(failure ? { error: failure } : {}) };
const reportFile = join(work, "react-matrix.json"); writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({passed, cases:results.length, expected:jobs.length, report:reportFile}, null, 2));
if (!passed) process.exitCode = 1;

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const value = (flag: string) => { const i = args.indexOf(flag); if (i < 0 || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Required ${flag}`); return resolve(args[i + 1]); };
const reportPath = value("--native-report");
const build = JSON.parse(readFileSync(reportPath, "utf8"));
if (build.status !== "built" || !build.binary || !build.binarySha256) throw new Error("Native report must record a successful independent source build");
const actual = createHash("sha256").update(readFileSync(build.binary)).digest("hex");
if (actual !== build.binarySha256) throw new Error("Binary does not match source-build attestation");
const root = dirname(reportPath);
const outputRoot = args.includes("--out") ? value("--out") : root;
mkdirSync(outputRoot, { recursive: true });
const testCase = args.includes("--test-case") ? args[args.indexOf("--test-case") + 1] : "*jsb*";
const result = spawnSync(build.binary, ["--headless", "--test", `--test-case=${testCase}`], {
  cwd: root, encoding: "utf8", timeout: 120_000,
  env: { ...process.env, GODOT_SILENCE_ROOT_WARNING: "1" }, maxBuffer: 16 * 1024 * 1024,
});
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const log = join(outputRoot, "react-native-tests.log");
writeFileSync(log, output);
const cases = output.match(/test cases:\s*(\d+)\s*\|\s*(\d+)\s*passed\s*\|\s*(\d+)\s*failed/i);
const assertions = output.match(/assertions:\s*(\d+)\s*\|\s*(\d+)\s*passed\s*\|\s*(\d+)\s*failed/i);
const passed = result.status === 0 && !result.error && !!cases && Number(cases[1]) > 0 && cases[1] === cases[2] && Number(cases[3]) === 0 && !!assertions && Number(assertions[3]) === 0 && /Status: SUCCESS!/.test(output);
const report = { schemaVersion: 1, passed, sourceCommit: build.sourceCommit, sourceSnapshotHash: build.sourceSnapshotHash,
  binarySha256: actual, engine: build.engine, testCase, exitCode: result.status, signal: result.signal, error: result.error?.message,
  nativeBuildReport: reportPath, godotBuildRecipe: build.godotBuildRecipe ? { kind: build.godotBuildRecipe.kind, originalGodotVersion: build.godotBuildRecipe.originalGodotVersion, patches: build.godotBuildRecipe.patches.map((x: any) => ({path: x.path, originalSha256: x.originalSha256, patchedSha256: x.patchedSha256})) } : undefined,
  cases: cases ? Number(cases[1]) : 0, assertions: assertions ? Number(assertions[1]) : 0, log };
writeFileSync(join(outputRoot, "react-native-tests.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {sitePayloads} from './site-evidence.mjs';

const args = process.argv.slice(2);
assert.equal(args.length, 4, 'Usage: node package-lifecycle-replay.mjs SITE EVIDENCE ENGINE_REPORT OUTPUT_DIRECTORY');
const [site, evidence, engineReport, output] = args.map(value => path.resolve(value));
for (const source of [site, evidence]) {
  assert(output !== source && !output.startsWith(source + path.sep) && !source.startsWith(output + path.sep),
    'The output must be separate from the site and evidence');
}
const scripts = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.dirname(output), {recursive: true});
const stage = await mkdtemp(path.join(path.dirname(output), '.lifecycle-replay-'));
try {
  const tools = path.join(stage, 'tools');
  const copiedEvidence = path.join(stage, 'evidence');
  await mkdir(tools);
  await mkdir(copiedEvidence);
  await cp(site, path.join(stage, 'site'), {recursive: true, errorOnExist: true, force: false});
  const report = JSON.parse(await readFile(path.join(evidence, 'report.json'), 'utf8'));
  assert(report.repair, 'The demo must include diagnostic repair evidence');
  for (const name of ['report.json', 'site-start.json', 'before.png', 'after.png', 'restart.png'])
    await cp(path.join(evidence, name), path.join(copiedEvidence, name));
  await cp(engineReport, path.join(copiedEvidence, 'engine-report.json'));
  for (const [source, target] of [['start-lifecycle-replay.mjs', 'start.mjs'],
    ['verify-lifecycle-replay.mjs', 'verify.mjs'], ['serve.mjs', 'serve.mjs'],
    ['site-evidence.mjs', 'site-evidence.mjs'], ['verify-summer-pixels.py', 'verify-summer-pixels.py']])
    await cp(path.join(scripts, source), path.join(tools, target));
  const verifier = 'verify-lifecycle-events.mjs';
  await build({entryPoints: [path.join(scripts, verifier)], outfile: path.join(tools, verifier), bundle: true,
    platform: 'node', format: 'esm', target: 'node24'});
  const pixels = execFileSync(process.execPath, [path.join(tools, 'verify-lifecycle-events.mjs'),
    path.join(copiedEvidence, 'report.json'), path.join(copiedEvidence, 'site-start.json')]);
  await writeFile(path.join(copiedEvidence, 'pixels.json'), pixels);
  await writeFile(path.join(stage, 'START-HERE.md'), `# Playground diagnostic repair and replay

Run \`node tools/start.mjs\` with Node.js 24. Open the printed URL in Chromium.
Choose API 调用 → engine.get_diagnostics → 打开独立示例 and follow
Summer：定位并修复类型错误, then Summer：等待启动与退出 on the same project.

Run \`node tools/verify.mjs\` with Python 3 and Pillow installed to verify the
site, diagnostic and lifecycle receipts, and the original game frames.
`);
  const payloads = await sitePayloads(stage);
  await writeFile(path.join(stage, 'SHA256SUMS'), Object.entries(payloads)
    .map(([name, {sha256}]) => sha256 + '  ' + name + '\n').join(''));
  execFileSync(process.execPath, [path.join(tools, 'verify.mjs')], {stdio: 'inherit'});
  await rename(stage, output);
} finally {
  await rm(stage, {recursive: true, force: true});
}

#!/usr/bin/env node
import { mkdtemp, mkdir, cp, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { options, inspectRelease, writeJson, json, fail, digest, verifyCDN } from './web-release-utils.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, npm_config_update_notifier: 'false' } });
  if (result.error || result.status !== 0) fail('E_RELEASE_CONSUMER', `${program} failed (${result.status}): ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

export async function verifyRelease(configuration) {
  const root = resolve(configuration.dir ?? 'scripts/jsb.web-engine/dist');
  const descriptor = await inspectRelease(root, { requireCertified: configuration['require-certified'] === true });
  const packageRoot = resolve(configuration.package ?? 'scripts/jsb.web-engine');
  const packageTemplate = await json(resolve(packageRoot, 'package.json'));
  if (packageTemplate.private === true || packageTemplate.publishConfig?.access !== 'public') fail('E_RELEASE_PACKAGE', 'Engine package must be public and publishable');
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(descriptor.version ?? '')) fail('E_RELEASE_PACKAGE', 'Release requires an exact npm package version');
  const temporary = await mkdtemp(resolve(tmpdir(), 'godot-web-consumer-'));
  const destination = resolve(configuration['pack-out'] ?? temporary);
  await mkdir(destination, { recursive: true });
  try {
    const staged = resolve(temporary, 'package'); await mkdir(staged);
    const packageJson = { ...packageTemplate, version: descriptor.version };
    // This is the package consumers receive, with no workspace dependency or
    // access to the checkout. Nothing executes during installation.
    delete packageJson.scripts;
    if (Object.keys(packageJson.dependencies ?? {}).length) fail('E_RELEASE_PACKAGE', 'Static engine package must not depend on install-time workspace packages');
    await writeJson(resolve(staged, 'package.json'), packageJson);
    await cp(root, resolve(staged, 'dist'), { recursive: true });
    await cp(resolve(packageRoot, 'README.md'), resolve(staged, 'README.md'));
    const packed = JSON.parse(command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], staged));
    if (packed.length !== 1 || !packed[0].filename) fail('E_RELEASE_PACK', 'npm pack did not return one tarball');
    const tarball = resolve(destination, packed[0].filename);
    const names = new Set(packed[0].files.map(file => file.path));
    for (const path of ['dist/release.json', ...descriptor.files.map(file => `dist/${file.path}`)]) if (!names.has(path)) fail('E_RELEASE_PACK', `npm pack omitted ${path}`);
    for (const name of names) if (!['package.json', 'README.md', 'LICENSE', 'LICENSE.md'].includes(name) && !name.startsWith('dist/')) fail('E_RELEASE_PACK', `Unexpected package file ${name}`);
    const consumer = resolve(temporary, 'consumer'); await mkdir(consumer);
    await writeJson(resolve(consumer, 'package.json'), { name: 'godot-web-release-consumer', private: true, type: 'module' });
    command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], consumer);
    const consumerDescriptorPath = command(process.execPath, ['--input-type=module', '-e', `import {createRequire} from 'node:module'; const require=createRequire(process.cwd()+'/package.json'); process.stdout.write(require.resolve(${JSON.stringify(`${packageJson.name}/release.json`)}));`], consumer);
    const installed = await inspectRelease(dirname(consumerDescriptorPath), { requireCertified: configuration['require-certified'] === true });
    if (installed.id !== descriptor.id) fail('E_RELEASE_CONSUMER', 'Installed package identity changed');
    const result = { status: 'verified', id: descriptor.id, certified: descriptor.certified, sourceCertified: descriptor.sourceCertified, package: packageJson.name, version: packageJson.version, externalConsumer: true, tarball: configuration['pack-out'] ? tarball : undefined, tarballSha256: digest(await readFile(tarball)), packageBytes: packed[0].size, unpackedBytes: packed[0].unpackedSize, maxFileBytes: Math.max(...descriptor.files.map(file => file.bytes)), cdnVerified: false };
    if (configuration['cdn-base']) result.cdnVerified = await verifyCDN({ baseUrl: configuration['cdn-base'], descriptor });
    if (configuration.report) await writeJson(resolve(configuration.report), result);
    return result;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyRelease(options(process.argv.slice(2), ['--require-certified'])))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

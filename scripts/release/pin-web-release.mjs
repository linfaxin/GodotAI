#!/usr/bin/env node
import { cp, readFile, rm, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { options, required, inspectRelease, json, digest, writeJson } from './web-release-utils.mjs';

/** Bind the complete final descriptor, including certification evidence, into
 * the static application after attaching evidence to a tested candidate. */
export async function pinRelease(configuration) {
  const site = resolve(required(configuration.site, '--site'));
  const source = resolve(required(configuration.release, '--release'));
  const release = await inspectRelease(source);
  const target = resolve(site, 'release');
  const configPath = resolve(site, 'app-config.json');
  const config = await json(configPath);
  if (source !== target) {
    const temporary = resolve(site, `.release-${process.pid}-${Date.now()}`);
    await mkdir(site, { recursive: true });
    try { await cp(source, temporary, { recursive: true }); await inspectRelease(temporary); await rm(target, { recursive: true, force: true }); await rename(temporary, target); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
  config.releaseUrl = './release/release.json';
  config.expectedReleaseId = release.id;
  config.expectedDescriptorSha256 = digest(await readFile(resolve(target, 'release.json')));
  await writeJson(configPath, config);
  return { status: 'pinned', site, id: release.id, certified: release.certified, descriptorSha256: config.expectedDescriptorSha256 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await pinRelease(options(process.argv.slice(2))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

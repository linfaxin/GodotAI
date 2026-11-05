#!/usr/bin/env node
import { mkdir, readFile, writeFile, copyFile, readdir, stat, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease } from '../release/build-web-release.mjs';
import { options, digest, writeJson } from '../release/web-release-utils.mjs';
import { buildPlayground } from '../../apps/playground/build.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(repo, 'scripts/jsb.react-build/package.json'));
const { build } = require('esbuild');
const sdk = resolve(repo, 'scripts/jsb.react');
const sdkRequire = createRequire(resolve(sdk, 'package.json'));
export async function preparePlayground(config) {
  const out = resolve(config.out ?? resolve(repo, '../work/browser-implementation/site'));
  if (!config['engine-report']) throw Error('Pass --engine-report from build-browser-engine.mjs');
  const assetsRoot = resolve(out, '../release-inputs');
  await mkdir(assetsRoot, { recursive: true });
  const { CANONICAL_IMPORTS, bootstrapSource } = await import('../jsb.react-build/dist/core/index.js');
  const { RUNTIME_ABI, NATIVE_BRIDGE_ABI, REACT_VERSIONS } = sdkRequire('./dist/contracts/index.js');
  const { profileReference } = sdkRequire('./dist/schema/index.js');
  const members = { React: sdkRequire.resolve('react'), jsxRuntime: sdkRequire.resolve('react/jsx-runtime'), jsxDevRuntime: sdkRequire.resolve('react/jsx-dev-runtime'), sdk: sdkRequire.resolve('./dist/index.js'), godot: sdkRequire.resolve('./dist/godot.js'), scheduler: sdkRequire.resolve('./dist/scheduler.js'), contracts: sdkRequire.resolve('./dist/contracts/index.js'), schema: sdkRequire.resolve('./dist/schema/index.js'), nativeInterfaces: sdkRequire.resolve('./dist/native-interfaces.js'), ui: sdkRequire.resolve('./dist/ui.js') };
  for (const [name, expected] of Object.entries({ react: REACT_VERSIONS.react, 'react-reconciler': REACT_VERSIONS.reconciler, scheduler: REACT_VERSIONS.scheduler })) if (sdkRequire(name + '/package.json').version !== expected) throw Error('E_RUNTIME_VERSION: ' + name);
  const sdkFiles = {};
  for (const mode of ['development', 'production']) {
    const output = resolve(assetsRoot, `sdk-${mode}.js`);
    await build({ stdin: { contents: Object.entries(members).map(([name, filename]) => `exports.${name}=require(${JSON.stringify(filename)});`).join('\n'), resolveDir: sdk, sourcefile: 'runtime-vendor.js' },
      bundle: true, platform: 'neutral', format: 'cjs', target: 'es2022', outfile: output, sourcemap: 'external', sourcesContent: true,
      inject: [resolve(sdk, 'dist/internal/performance.mjs')], define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
      plugins: [{ name: 'canonical-native-scheduler', setup(b) { b.onResolve({ filter: /^(godot|godot-jsb)$/ }, args => ({ path: args.path, external: true })); b.onResolve({ filter: /^scheduler$/ }, () => ({ path: members.scheduler })); } }],
    }); sdkFiles[mode] = output;
  }
  const contracts = resolve(assetsRoot, 'contracts.mjs');
  await build({ stdin: { contents: `export {RUNTIME_ABI,NATIVE_BRIDGE_ABI,REACT_VERSIONS,validateRuntimeManifest} from ${JSON.stringify(members.contracts)}; export {profileReference} from ${JSON.stringify(members.schema)};`, resolveDir: sdk }, bundle: true, platform: 'browser', format: 'esm', outfile: contracts });
  const bootstrap = resolve(assetsRoot, 'bootstrap.json'); await writeJson(bootstrap, { source: bootstrapSource('app', 'generated/react') });
  const types = resolve(assetsRoot, 'types');
  await rm(types, { recursive: true, force: true });
  async function copyDeclarations(source, destination) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = resolve(source, entry.name), to = resolve(destination, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git', 'test', 'tests'].includes(entry.name)) await copyDeclarations(from, to);
      else if (entry.isFile() && (/\.d\.[cm]?ts$/.test(entry.name) || entry.name === 'package.json')) await copyFile(from, to);
    }
  }
  await copyDeclarations(resolve(sdk, 'dist'), resolve(types, 'node_modules/@godot-js/react/dist'));
  await copyFile(resolve(sdk, 'package.json'), resolve(types, 'node_modules/@godot-js/react/package.json'));
  const reactTypes = dirname(sdkRequire.resolve('@types/react/package.json'));
  await copyDeclarations(reactTypes, resolve(types, 'node_modules/@types/react'));
  const reactRequire = createRequire(resolve(reactTypes, 'package.json'));
  await copyDeclarations(dirname(reactRequire.resolve('csstype/package.json')), resolve(types, 'node_modules/csstype'));
  await mkdir(resolve(types, 'node_modules/@types/godot-runtime'), { recursive: true });
  await writeJson(resolve(types, 'node_modules/@types/godot-runtime/package.json'), { name: '@types/godot-runtime', version: '0.1.0', types: 'index.d.ts' });
  await writeFile(resolve(types, 'node_modules/@types/godot-runtime/index.d.ts'), `/** Globals provided by the selected GodotJS Web host. DOM/Node APIs are not implied. */\ndeclare const console: { log(...values: unknown[]): void; info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void; debug(...values: unknown[]): void };\ndeclare function setTimeout(callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]): number;\ndeclare function clearTimeout(handle?: number): void;\ndeclare function setInterval(callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]): number;\ndeclare function clearInterval(handle?: number): void;\n`);
  const tsRoot = dirname(require.resolve('typescript/package.json'));
  await mkdir(resolve(types, 'typescript/lib'), { recursive: true });
  for (const name of await readdir(resolve(tsRoot, 'lib'))) if (/^lib\..*\.d\.ts$/.test(name)) await copyFile(resolve(tsRoot, 'lib', name), resolve(types, 'typescript/lib', name));
  const compilerJs = resolve(assetsRoot, 'esbuild-browser.js'), compilerWasm = resolve(assetsRoot, 'esbuild.wasm');
  for (const [url, target] of [['https://cdn.jsdelivr.net/npm/esbuild-wasm@0.25.12/lib/browser.min.js', compilerJs], ['https://cdn.jsdelivr.net/npm/esbuild-wasm@0.25.12/esbuild.wasm', compilerWasm]]) {
    try { await stat(target); } catch { const response = await fetch(url); if (!response.ok) throw Error('E_COMPILER_DOWNLOAD: ' + response.status); await writeFile(target, new Uint8Array(await response.arrayBuffer())); }
  }
  const profiles = ['core-ui-v1', 'behavior-physics-v1'];
  try { profileReference('ui-media-v1'); profiles.push('ui-media-v1'); } catch {}
  const assets = { sdk: sdkFiles, types, contracts, bootstrap,
    compiler: { js: compilerJs, wasm: compilerWasm, typescript: resolve(tsRoot, 'lib/typescript.js') },
    metadata: { version: config.version ?? '0.1.0', sdkVersion: sdkRequire('./package.json').version, runtimeAbi: RUNTIME_ABI, nativeBridgeAbi: NATIVE_BRIDGE_ABI, react: REACT_VERSIONS,
      profiles: profiles.map(id => profileReference(id)), specifiers: CANONICAL_IMPORTS, sdkPackageRoot: '/node_modules/@godot-js/react', typesRoot: '/node_modules/@types', libRoot: '/typescript/lib' },
  };
  await mkdir(out, { recursive: true }); const assetsPath = resolve(out, 'release-assets.json'); await writeJson(assetsPath, assets);
  const result = await buildRelease({ 'engine-report': resolve(config['engine-report']), assets: assetsPath, out: resolve(out, 'release'), development: !!config.development, version: config.version ?? '0.1.0' });
  await buildPlayground({ out, config: { expectedReleaseId: result.id, expectedDescriptorSha256: digest(await readFile(resolve(out, 'release/release.json'))), ...(config['preview-url'] ? { previewUrl: config['preview-url'] } : {}) } });
  return { status: 'prepared', site: out, release: result };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await preparePlayground(options(process.argv.slice(2), ['--development'])))); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}

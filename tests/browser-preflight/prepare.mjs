// Development-time packaging only. The served application never calls Node.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const require = createRequire(resolve(repo, 'scripts/jsb.react-build/package.json'));
const { build } = require('esbuild');
const sdk = resolve(repo, 'scripts/jsb.react');
const out = resolve(process.argv[2] ?? resolve(repo, '../work/browser-preflight/site'));
if (!process.env.GODOT_SOURCE) throw Error('Set GODOT_SOURCE to the source tree used to build the Web engine');
await mkdir(resolve(out, 'assets'), { recursive: true });
for (const name of await readdir(here)) {
  if (['index.html', 'main.js', 'compiler.js', 'pck.js', 'preview.html', 'preview.js', 'Counter.tsx'].includes(name))
    await copyFile(resolve(here, name), resolve(out, name));
}
const sdkRequire = createRequire(resolve(sdk, 'package.json'));
const paths = {
  React: sdkRequire.resolve('react'),
  jsxRuntime: sdkRequire.resolve('react/jsx-runtime'),
  jsxDevRuntime: sdkRequire.resolve('react/jsx-dev-runtime'),
  sdk: resolve(sdk, 'dist/index.js'),
  godot: resolve(sdk, 'dist/godot.js'),
  scheduler: resolve(sdk, 'dist/scheduler.js'),
  contracts: resolve(sdk, 'dist/contracts/index.js'),
  schema: resolve(sdk, 'dist/schema/index.js'),
  nativeInterfaces: resolve(sdk, 'dist/native-interfaces.js'),
};
const { REACT_VERSIONS } = sdkRequire('./dist/contracts/index.js');
for (const [name, version] of Object.entries({ react: REACT_VERSIONS.react, 'react-reconciler': REACT_VERSIONS.reconciler, scheduler: REACT_VERSIONS.scheduler })) {
  if (sdkRequire(`${name}/package.json`).version !== version) throw Error(`Runtime version mismatch: ${name}`);
}
const vendor = await build({
  stdin: { contents: Object.entries(paths).map(([name, path]) => `exports.${name}=require(${JSON.stringify(path)});`).join('\n'), resolveDir: sdk },
  bundle: true, write: false, platform: 'neutral', format: 'cjs', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  inject: [resolve(sdk, 'dist/internal/performance.mjs')],
  plugins: [{ name: 'native-and-private-scheduler', setup(b) {
    b.onResolve({ filter: /^(godot|godot-jsb)$/ }, args => ({ path: args.path, external: true }));
    b.onResolve({ filter: /^scheduler$/ }, () => ({ path: paths.scheduler }));
  } }],
});
await writeFile(resolve(out, 'assets/runtime.json'), JSON.stringify({ code: vendor.outputFiles[0].text }));
await build({
  stdin: { contents: `export {RUNTIME_ABI,NATIVE_BRIDGE_ABI,REACT_VERSIONS,validateRuntimeManifest} from ${JSON.stringify(paths.contracts)}; export {profileReference} from ${JSON.stringify(paths.schema)};`, resolveDir: sdk },
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', outfile: resolve(out, 'assets/contracts.mjs'),
});
const { bootstrapSource } = await import(resolve(repo, 'scripts/jsb.react-build/dist/bootstrap.js'));
await writeFile(resolve(out, 'assets/bootstrap.json'), JSON.stringify({ source: bootstrapSource('app', 'generated/react') }));
// Engine version comes from this exact build's generated header, rather than a guessed release name.
if (process.env.GODOT_SOURCE) {
  const header = await readFile(resolve(process.env.GODOT_SOURCE, 'core/version_generated.gen.h'), 'utf8');
  const hashHeader = await readFile(resolve(process.env.GODOT_SOURCE, 'core/version_hash.gen.cpp'), 'utf8');
  const get = name => header.match(new RegExp(`#define (?:GODOT_)?${name} "([^"]*)"`))?.[1];
  const major = header.match(/#define (?:GODOT_)?VERSION_MAJOR (\d+)/)?.[1];
  const minor = header.match(/#define (?:GODOT_)?VERSION_MINOR (\d+)/)?.[1];
  const patch = header.match(/#define (?:GODOT_)?VERSION_PATCH (\d+)/)?.[1];
  const hash = hashHeader.match(/(?:GODOT_)?VERSION_HASH = "([^"]*)"/)?.[1] ?? '';
  if (!major || !minor || !patch || !get('VERSION_STATUS') || !get('VERSION_BUILD')) throw Error('Unrecognized Godot version header');
  const version = `${major}.${minor}${patch !== '0' ? '.' + patch : ''}.${get('VERSION_STATUS')}.${get('VERSION_BUILD')}${hash ? '.' + hash.slice(0, 9) : ''}`;
  await writeFile(resolve(out, 'assets/target.json'), JSON.stringify({ godotVersion: version, engine: 'web' }));
}
if (process.env.GODOT_WEB_TEMPLATE) {
  const archive = resolve(process.env.GODOT_WEB_TEMPLATE);
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
  for (const name of ['godot.js', 'godot.wasm', 'godot.audio.worklet.js', 'godot.audio.position.worklet.js']) {
    const entry = entries.find(path => path === name || path.endsWith('/' + name));
    if (!entry) throw Error(`Web template is missing ${name}`);
    await writeFile(resolve(out, 'assets', name), execFileSync('unzip', ['-p', archive, entry], { maxBuffer: 128 * 1024 * 1024 }));
  }
}
console.log(out);

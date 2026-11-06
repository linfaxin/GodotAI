import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const here = dirname(fileURLToPath(import.meta.url));

export async function buildBuiltInLibraries() {
  const versions = JSON.parse(await readFile(resolve(here, 'builtin-catalog.json'), 'utf8'));
  const sdk = createRequire(resolve(here, '../../scripts/jsb.react/package.json'));
  const { REACT_VERSIONS } = sdk('./dist/contracts/index.js');
  if (versions.react !== REACT_VERSIONS.react || versions.scheduler !== REACT_VERSIONS.scheduler || versions['@godot-js/react'] !== sdk('./package.json').version) throw Error('Built-in catalog differs from the SDK release');
  const require = createRequire(resolve(here, 'package.json'));
  const metadata = JSON.parse(await readFile(resolve(here, 'node_modules/clsx/package.json'), 'utf8'));
  if (metadata.version !== versions.clsx) throw Error('Installed clsx differs from builtin-catalog.json');
  const { build } = require('esbuild');
  const result = await build({ entryPoints: [require.resolve('clsx')], bundle: true, write: false, platform: 'neutral', format: 'cjs', target: 'es2022', minify: true });
  return { versions, modules: { clsx: '/node_modules/clsx/index.cjs' }, files: {
    '/node_modules/scheduler/index.d.ts': 'export * from "@godot-js/react/scheduler";\n',
    '/node_modules/scheduler/package.json': JSON.stringify({ name: 'scheduler', version: versions.scheduler, types: './index.d.ts' }),
    '/node_modules/clsx/index.cjs': result.outputFiles[0].text + '\n/*!\n' + (await readFile(resolve(here, 'node_modules/clsx/license'), 'utf8')).replace(/\*\//g, '* /') + '\n*/\n',
    '/node_modules/clsx/index.d.ts': await readFile(resolve(here, 'node_modules/clsx', metadata.types), 'utf8'),
    '/node_modules/clsx/package.json': JSON.stringify({ name: 'clsx', version: metadata.version, main: './index.cjs', types: './index.d.ts' }),
  } };
}

export function builtInLibrariesPlugin() {
  return { name: 'playground-builtins', setup(api) {
    api.onResolve({ filter: /^playground:builtins$/ }, () => ({ path: 'libraries', namespace: 'playground-builtins' }));
    api.onLoad({ filter: /.*/, namespace: 'playground-builtins' }, async () => ({ contents: 'export const libraries = ' + JSON.stringify(await buildBuiltInLibraries()) + ';', loader: 'js' }));
  } };
}

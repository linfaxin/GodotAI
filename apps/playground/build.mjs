import { createRequire } from 'node:module';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtInLibrariesPlugin } from './build-builtins.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, '../../scripts/jsb.react-build/package.json'));
const { build } = require('esbuild');
export async function buildPlayground({ out = resolve(here, 'dist'), config = {} } = {}) {
  await mkdir(out, { recursive: true });
  await build({ entryPoints: { main: resolve(here, 'main.ts'), preview: resolve(here, 'preview.ts'), 'compiler-worker': resolve(here, 'compiler-worker.ts'), 'types-worker': resolve(here, '../../scripts/jsb.react-browser/src/types-worker.ts'), 'monaco-editor-worker': resolve(here, 'editor.worker.ts') },
    outdir: out, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', sourcemap: true,
    minify: true, sourcesContent: false, loader: { '.ttf': 'file' }, assetNames: 'assets/[name]-[hash]',
    plugins: [builtInLibrariesPlugin()], define: { 'process.env.NODE_ENV': '"production"' } });
  for (const file of ['index.html', 'preview.html', 'style.css']) await copyFile(resolve(here, file), resolve(out, file));
  await mkdir(resolve(out, 'assets'), { recursive: true });
  for (const file of ['LICENSE', 'ThirdPartyNotices.txt']) await copyFile(resolve(here, 'node_modules/monaco-editor', file), resolve(out, 'assets/monaco-' + file + (file.endsWith('.txt') ? '' : '.txt')));
  await copyFile(resolve(here, 'node_modules/clsx/license'), resolve(out, 'assets/clsx-LICENSE.txt'));
  await writeFile(resolve(out, 'app-config.json'), JSON.stringify({ releaseUrl: './release/release.json', previewUrl: './preview.html', ...config }, null, 2));
  return out;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(await buildPlayground());

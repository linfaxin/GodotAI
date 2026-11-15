import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {existsSync} from 'node:fs';

/** Prefer the browser revision pinned by the installed Playwright package.
 * A system Chromium is only a detected local fallback, never an assumed CI
 * dependency. Explicit paths fail closed rather than silently changing engines. */
export function resolveBrowserExecutable(type,name,{environment=process.env,exists=existsSync}={}){
  if(!['chromium','firefox','webkit'].includes(name)||typeof type?.executablePath!=='function')throw Error('E_BROWSER_EXECUTABLE: Unknown browser '+String(name));
  const override=environment.BROWSER_EXECUTABLE??(name==='chromium'?(environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE??environment.CHROMIUM):undefined);
  if(override){if(!exists(override))throw Error('E_BROWSER_EXECUTABLE: Explicit browser does not exist: '+override);return {executablePath:override,source:'override'};}
  const bundled=type.executablePath();
  if(bundled&&exists(bundled))return {executablePath:bundled,source:'playwright-managed'};
  if(name==='chromium')for(const filename of ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'])if(exists(filename))return {executablePath:filename,source:'system-fallback'};
  throw Error('E_BROWSER_EXECUTABLE: Install the locked Playwright browser: pnpm --filter @godot-js/playground exec playwright install --with-deps '+name);
}

/** Shared real-browser configuration. Firefox/WebKit use Playwright's installed
 * builds; Chromium retains the repository's system-browser default. */
export async function browserDriver() {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const module = process.env.PLAYWRIGHT_MODULE ?? resolve(repository, '../work/browser-preflight/tools/node_modules/playwright-core/index.mjs');
  const name = process.env.BROWSER ?? 'chromium';
  if (!['chromium', 'firefox', 'webkit'].includes(name)) throw new Error(`Unknown BROWSER=${name}`);
  const playwright = await import(pathToFileURL(resolve(module)).href);
  const executablePath = process.env.BROWSER_EXECUTABLE ?? (name === 'chromium' ? process.env.CHROMIUM ?? '/usr/bin/chromium' : undefined);
  const launchOptions = {
    headless: process.env.BROWSER_HEADLESS !== '0',
    ...(executablePath ? { executablePath } : {}),
    ...(name === 'chromium' ? { args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}),
    ...(name === 'firefox' ? { firefoxUserPrefs: { 'webgl.force-enabled': true, 'webgl.disabled': false, 'gfx.webrender.software': true, 'security.enterprise_roots.enabled': true } } : {}),
    ...(process.env.BROWSER_PROXY ? { proxy: { server: process.env.BROWSER_PROXY, bypass: '127.0.0.1,localhost' } } : {}),
  };
  return { name, type: playwright[name], launchOptions };
}

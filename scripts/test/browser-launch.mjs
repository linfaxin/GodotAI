import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

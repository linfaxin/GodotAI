import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.pck': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.ts': 'text/plain; charset=utf-8', '.tsx': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

/** Static, read-only fixture server. No COOP or COEP is emitted. Run two
 * instances with host localhost and 127.0.0.1 to exercise cross-site previews. */
export async function serveBrowserSite({ root, host = '127.0.0.1', port = 0, csp, corsOrigin = '*', headers = {}, authorize }) {
  for (const name of Object.keys(headers)) if (/^cross-origin-(?:opener|embedder)-policy$/i.test(name)) throw new Error('Browser fixture must remain explicitly non-isolated');
  const directory = await realpath(resolve(root)), requests = [];
  const server = createServer(async (request, response) => {
    const entry = { method: request.method, url: request.url, status: 500, cookiePresent: !!request.headers.cookie }; requests.push(entry);
    const finish = (status, body = '') => { entry.status = status; response.statusCode = status; response.end(request.method === 'HEAD' ? undefined : body); };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (corsOrigin) response.setHeader('Access-Control-Allow-Origin', corsOrigin);
    if (csp) response.setHeader('Content-Security-Policy', csp);
    for (const [name, value] of Object.entries(headers)) {
      response.setHeader(name, value);
    }
    if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); finish(405, 'Read-only static server'); return; }
    try {
      if (authorize && await authorize(request) !== true) { finish(401, 'Authentication required'); return; }
      const pathname = decodeURIComponent(new URL(request.url, 'http://fixture.invalid').pathname);
      if (pathname.includes('\0') || pathname.includes('\\')) { finish(400, 'Invalid path'); return; }
      let path = resolve(directory, `.${pathname}`);
      if (path !== directory && !path.startsWith(`${directory}${sep}`)) { finish(403, 'Forbidden'); return; }
      if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
      path = await realpath(path);
      if (!path.startsWith(`${directory}${sep}`)) { finish(403, 'Forbidden'); return; }
      const bytes = await readFile(path);
      response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
      response.setHeader('Content-Length', bytes.length);
      finish(200, bytes);
    } catch (error) { finish(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : error instanceof URIError ? 400 : 500, 'Static file unavailable'); }
  });
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, host, resolveReady); });
  const address = server.address();
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  return { server, root: directory, url: origin, origin, requests,
    close: () => new Promise((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed())) };
}

export const serve = (root, options = {}) => serveBrowserSite({ root, ...options });

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Static bytes only: no compiler, process spawning, or write API.
export async function serve(root, port = 0) {
  root = resolve(root);
  const requests = [];
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.tsx': 'text/plain' };
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
      if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      const file = path === root ? resolve(root, 'index.html') : path;
      const bytes = await readFile(file);
      // Deliberately omit COOP/COEP: the single-thread preflight must work without isolation.
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const service = await serve(process.argv[2] ?? '../work/browser-preflight/site', Number(process.argv[3] ?? 8080));
  console.log(service.url);
}

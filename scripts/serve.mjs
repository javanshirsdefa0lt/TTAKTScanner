import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.gz': 'application/gzip', '.wasm': 'application/wasm', '.pdf': 'application/pdf' };
const server = createServer((request, response) => {
  const requested = new URL(request.url, 'http://localhost').pathname;
  const safe = normalize(requested === '/' ? '/index.html' : requested).replace(/^([/\\])+/, '');
  const file = join(root, safe);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) { response.writeHead(404); response.end('Not found'); return; }
  const size = statSync(file).size;
  response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(response);
});
server.listen(4173, () => console.log('Local URL: http://localhost:4173'));

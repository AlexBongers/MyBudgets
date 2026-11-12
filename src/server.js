// Ontwikkel-/browsermodus: dezelfde API over HTTP op 127.0.0.1 (de Electron-app gebruikt IPC).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApi, demoCSVFrom } from './service.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUB = join(ROOT, 'renderer');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createServer(db) {
  const api = createApi(db, { demoCSV: demoCSVFrom(join(ROOT, 'samples/rabobank-demo.csv')) });
  return http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)); };
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname.startsWith('/api/')) {
        let body = {};
        if (req.method !== 'GET' && req.method !== 'DELETE') {
          const chunks = []; for await (const c of req) chunks.push(c);
          const raw = Buffer.concat(chunks).toString('utf8'); body = raw ? JSON.parse(raw) : {};
        }
        return send(200, await api(req.method, u.pathname + u.search, body));
      }
      const rel = u.pathname === '/' ? 'index.html' : normalize(u.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(PUB, rel);
      if (!file.startsWith(PUB)) return send(403, 'Forbidden', 'text/plain');
      try { send(200, await readFile(file), MIME[extname(file)] || 'application/octet-stream'); } catch { send(404, 'Not found', 'text/plain'); }
    } catch (e) { send(e.status || 500, { error: e.message }); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createServer(openDb(process.env.DB_PATH || 'data/budget.db')).listen(port, '127.0.0.1', () => console.log(`MyBudgets dev-server op http://localhost:${port}`));
}

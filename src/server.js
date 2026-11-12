// Ontwikkel-/browsermodus: dezelfde API over HTTP op 127.0.0.1 (de Electron-app gebruikt IPC).
import http from 'node:http';
import { readFile, unlink } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, renameSync, writeFileSync } from 'node:fs';
import { openDb, backupTo } from './db.js';
import { createApi, demoCSVFrom } from './service.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUB = join(ROOT, 'renderer');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const sha = v => createHash('sha256').update(String(v)).digest();
const MAX_BODY = 200 * 1024 * 1024;   // een Actual-export als base64 kan groot zijn

// opts.password: wachtwoord (HTTP Basic, gebruikersnaam maakt niet uit) — nodig zodra de server buiten localhost bereikbaar is.
// Met een wachtwoord accepteren we elke Host-header (intern IP, hostnaam, reverse proxy); DNS-rebinding levert dan niets op,
// omdat de browser het wachtwoord alleen naar de oorspronkelijke origin stuurt.
export function createServer(db, extraCtx = {}, opts = {}) {
  const wantHash = opts.password ? sha(opts.password) : null;
  const api = createApi(db, { demoCSV: demoCSVFrom(join(ROOT, "samples/rabobank-demo.csv")), ...extraCtx });
  return http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)); };
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/healthz') return send(200, { ok: true });
      if (wantHash) {
        const m = /^Basic (.+)$/i.exec(req.headers.authorization || ''); const given = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
        const pw = given.slice(given.indexOf(':') + 1);
        if (!m || !timingSafeEqual(sha(pw), wantHash)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MyBudgets", charset="UTF-8"', 'Content-Type': 'text/plain' }); return res.end('Inloggen vereist'); }
      }
      // Bescherming tegen DNS-rebinding en CSRF vanuit andere websites: alleen lokale Host-headers, en schrijfacties
      // moeten application/json zijn (dat dwingt een CORS-preflight af, die we nooit goedkeuren).
      if (!wantHash && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) return send(403, { error: 'Ongeldige host' });
      if (u.pathname === '/api/backup' && req.method === 'GET') {
        const tmp = join(tmpdir(), `mybudgets-dl-${process.pid}-${Date.now()}.db`);
        try { backupTo(db, tmp); const buf = await readFile(tmp); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="MyBudgets-backup-${new Date().toISOString().slice(0, 10)}.db"` }); return res.end(buf); }
        finally { unlink(tmp).catch(() => {}); }
      }
      if (u.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'DELETE' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(415, { error: 'Content-Type moet application/json zijn' });
        if (req.method === 'DELETE' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, { error: 'Ongeldige oorsprong' });
        let body = {};
        if (req.method !== 'GET' && req.method !== 'DELETE') {
          const chunks = []; let size = 0; for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(413, { error: 'Bestand te groot' }); chunks.push(c); }
          const raw = Buffer.concat(chunks).toString('utf8'); body = raw ? JSON.parse(raw) : {};
        }
        if (u.pathname === '/api/restore-db' && req.method === 'POST' && opts.restore) { const r = opts.restore(Buffer.from(String(body.base64 || ''), 'base64')); send(200, r); return opts.afterRestore?.(); }
        return send(200, await api(req.method, u.pathname + u.search, body));
      }
      const rel = u.pathname === '/' ? 'index.html' : normalize(u.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(PUB, rel);
      if (!file.startsWith(PUB)) return send(403, 'Forbidden', 'text/plain');
      try { send(200, await readFile(file), MIME[extname(file)] || 'application/octet-stream'); } catch { send(404, 'Not found', 'text/plain'); }
    } catch (e) { send(e.status || 500, { error: e.message }); }
  });
}

// Dagelijkse back-up naast de database (14 bewaard); alleen in servermodus.
function dailyBackup(db, dbPath) {
  try {
    const dir = join(dirname(dbPath), 'backups'); mkdirSync(dir, { recursive: true });
    const file = join(dir, `budget-${new Date().toISOString().slice(0, 10)}.db`);
    if (!existsSync(file)) backupTo(db, file);
    const all = readdirSync(dir).filter(f => /^budget-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of all.slice(0, -14)) unlinkSync(join(dir, f));
  } catch (e) { console.error('Back-up mislukt:', e.message); }
}

// Herstellen in servermodus: het bestand wordt gecontroleerd en klaargezet; bij de volgende start (de server sluit zichzelf
// af en Docker/systemd start hem opnieuw) wordt het na een veiligheidskopie in de plaats van de database gezet.
export function validBackup(path) {
  let t = null;
  try { t = new DatabaseSync(path, { readOnly: true }); return t.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('transactions','categories')").get().c === 2 && t.prepare('PRAGMA integrity_check').get().integrity_check === 'ok'; }
  catch { return false; } finally { try { t?.close(); } catch { /* niets */ } }
}
export function applyPendingRestore(dbPath) {
  const pending = dbPath + '.restore';
  if (!existsSync(pending)) return false;
  try {
    if (validBackup(pending)) {
      if (existsSync(dbPath)) { const bd = join(dirname(dbPath), 'backups'); mkdirSync(bd, { recursive: true }); copyFileSync(dbPath, join(bd, `voor-herstel-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)); }
      for (const ext of ['-wal', '-shm']) if (existsSync(dbPath + ext)) unlinkSync(dbPath + ext);
      renameSync(pending, dbPath); return true;
    }
  } catch (e) { console.error('Herstellen mislukt:', e.message); }
  try { unlinkSync(pending); } catch { /* weg */ }
  return false;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000, host = process.env.HOST || '127.0.0.1', password = process.env.MYBUDGETS_PASSWORD || '';
  const dbPath = process.env.DB_PATH || 'data/budget.db';
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host) && !password && process.env.MYBUDGETS_ALLOW_NO_AUTH !== '1') {
    console.error('Weigert te starten: HOST staat open voor het netwerk maar MYBUDGETS_PASSWORD is niet gezet.\nZet een wachtwoord (aanbevolen) of MYBUDGETS_ALLOW_NO_AUTH=1.'); process.exit(1);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  if (applyPendingRestore(dbPath)) console.log('Back-up hersteld.');
  const db = openDb(dbPath);
  if (process.env.MYBUDGETS_BACKUPS !== '0') { dailyBackup(db, dbPath); setInterval(() => dailyBackup(db, dbPath), 6 * 3600e3).unref(); }
  const restore = buf => {
    const pending = dbPath + '.restore'; writeFileSync(pending, buf);
    if (!validBackup(pending)) { unlinkSync(pending); throw Object.assign(new Error('Dit is geen geldige MyBudgets-back-up.'), { status: 400 }); }
    return { ok: true, restarting: true };
  };
  const srv = createServer(db, {}, { password, restore, afterRestore: () => setTimeout(() => process.exit(0), 300) }).listen(port, host, () => console.log(`MyBudgets op http://${host}:${port}${password ? ' (met wachtwoord)' : ''}  database: ${dbPath}`));
  const stop = () => { srv.close(); try { dailyBackup(db, dbPath); db.close(); } catch { /* al gesloten */ } process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, importTransactions, applyRules, categorize } from './db.js';
import { parseRabobank } from './csv.js';

const PUB = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const monthRe = /^\d{4}-\d{2}$/;

function addMonths(m, n) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function createHandler(db) {
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  function budgetFor(month) {
    const spent = Object.fromEntries(q(`SELECT category_id c, SUM(amount) s FROM transactions
      WHERE substr(date,1,7)=? AND category_id IS NOT NULL GROUP BY category_id`, month).map(r => [r.c, r.s]));
    return q(`SELECT c.id, c.name, c.color,
        (SELECT amount FROM budgets b WHERE b.category_id=c.id AND b.month<=? ORDER BY month DESC LIMIT 1) AS budget
      FROM categories c WHERE c.kind='expense' ORDER BY c.name`, month)
      .map(r => ({ ...r, budget: r.budget ?? 0, spent: -(spent[r.id] ?? 0) }));
  }

  function monthTotals(month) {
    const r = one(`SELECT
      COALESCE(SUM(CASE WHEN c.kind='income' OR (c.id IS NULL AND t.amount>0) THEN t.amount END),0) AS income,
      COALESCE(-SUM(CASE WHEN c.kind='expense' OR (c.id IS NULL AND t.amount<0) THEN t.amount END),0) AS expenses
      FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
      WHERE substr(t.date,1,7)=?`, month);
    return r;
  }

  function dashboard(month) {
    const totals = monthTotals(month);
    const byCategory = q(`SELECT COALESCE(c.name,'Niet gecategoriseerd') name, COALESCE(c.color,'#9ca3af') color,
        -SUM(t.amount) value
      FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
      WHERE substr(t.date,1,7)=? AND (c.kind='expense' OR (c.id IS NULL AND t.amount<0))
      GROUP BY c.id HAVING value > 0 ORDER BY value DESC`, month);
    const trend = [];
    for (let i = 11; i >= 0; i--) { const m = addMonths(month, -i); trend.push({ month: m, ...monthTotals(m) }); }
    const topPayees = q(`SELECT t.payee, -SUM(t.amount) value, COUNT(*) n
      FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
      WHERE substr(t.date,1,7)=? AND (c.kind='expense' OR (c.id IS NULL AND t.amount<0))
      GROUP BY t.payee HAVING value > 0 ORDER BY value DESC LIMIT 8`, month);
    const budget = budgetFor(month).filter(b => b.budget > 0 || b.spent > 0);
    const uncategorized = one('SELECT COUNT(*) c FROM transactions WHERE category_id IS NULL').c;
    const months = q('SELECT DISTINCT substr(date,1,7) m FROM transactions ORDER BY m DESC').map(r => r.m);
    return { month, totals, byCategory, trend, topPayees, budget, uncategorized, months };
  }

  function listTransactions(u) {
    const p = u.searchParams, where = [], args = [];
    const month = p.get('month');
    if (month && monthRe.test(month)) { where.push('substr(t.date,1,7)=?'); args.push(month); }
    if (p.get('uncategorized') === '1') where.push('t.category_id IS NULL');
    else if (p.get('category')) { where.push('t.category_id=?'); args.push(Number(p.get('category'))); }
    if (p.get('q')) { where.push('(t.payee LIKE ? OR t.description LIKE ?)'); args.push(`%${p.get('q')}%`, `%${p.get('q')}%`); }
    const limit = Math.min(Number(p.get('limit')) || 500, 2000);
    return q(`SELECT t.id, t.date, t.amount, t.payee, t.description, t.category_id
      FROM transactions t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.date DESC, t.id DESC LIMIT ${limit}`, ...args);
  }

  const routes = {
    'GET /api/categories': () => q('SELECT * FROM categories ORDER BY kind, name'),
    'POST /api/categories': b => {
      if (!b.name?.trim()) throw httpErr(400, 'Naam ontbreekt');
      const r = run('INSERT INTO categories (name, kind, color) VALUES (?,?,?)', b.name.trim(), b.kind || 'expense', b.color || '#6b7280');
      return { id: Number(r.lastInsertRowid) };
    },
    'PUT /api/categories/:id': (b, { id }) => {
      run('UPDATE categories SET name=COALESCE(?,name), kind=COALESCE(?,kind), color=COALESCE(?,color) WHERE id=?',
        b.name ?? null, b.kind ?? null, b.color ?? null, id);
      return { ok: true };
    },
    'DELETE /api/categories/:id': (_, { id }) => { run('DELETE FROM categories WHERE id=?', id); return { ok: true }; },

    'GET /api/transactions': (_, __, u) => listTransactions(u),
    'PATCH /api/transactions/:id': (b, { id }) => {
      const tx = one('SELECT * FROM transactions WHERE id=?', id);
      if (!tx) throw httpErr(404, 'Transactie niet gevonden');
      const cat = b.category_id || null;
      run('UPDATE transactions SET category_id=? WHERE id=?', cat, id);
      let similar = 0;
      if (cat && b.createRule) {
        // Regel op tegenpartij; pas toe op alle nog niet gecategoriseerde transacties
        run('INSERT INTO rules (pattern, category_id) VALUES (?,?) ON CONFLICT(pattern) DO UPDATE SET category_id=excluded.category_id', tx.payee.toLowerCase(), cat);
        similar = run(`UPDATE transactions SET category_id=? WHERE payee=? AND id<>? AND (category_id IS NULL OR ?)`,
          cat, tx.payee, id, b.overwrite ? 1 : 0).changes;
      }
      return { ok: true, similar: Number(similar) };
    },
    'DELETE /api/transactions/:id': (_, { id }) => { run('DELETE FROM transactions WHERE id=?', id); return { ok: true }; },

    'POST /api/import': b => {
      let txs;
      try { txs = parseRabobank(b.csv || ''); } catch (e) { throw httpErr(400, e.message); }
      return importTransactions(db, txs);
    },

    'GET /api/rules': () => q(`SELECT r.id, r.pattern, r.category_id, c.name category FROM rules r
      JOIN categories c ON c.id=r.category_id ORDER BY c.name, r.pattern`),
    'POST /api/rules': b => {
      if (!b.pattern?.trim() || !b.category_id) throw httpErr(400, 'Patroon en categorie vereist');
      run('INSERT INTO rules (pattern, category_id) VALUES (?,?) ON CONFLICT(pattern) DO UPDATE SET category_id=excluded.category_id', b.pattern.trim().toLowerCase(), b.category_id);
      return { ok: true, applied: applyRules(db) };
    },
    'DELETE /api/rules/:id': (_, { id }) => { run('DELETE FROM rules WHERE id=?', id); return { ok: true }; },
    'POST /api/rules/apply': () => ({ applied: applyRules(db) }),

    'GET /api/budget': (_, __, u) => {
      const m = u.searchParams.get('month');
      if (!monthRe.test(m || '')) throw httpErr(400, 'month=YYYY-MM vereist');
      return budgetFor(m);
    },
    'PUT /api/budget': b => {
      if (!monthRe.test(b.month || '') || !b.category_id) throw httpErr(400, 'month en category_id vereist');
      run('INSERT INTO budgets (category_id, month, amount) VALUES (?,?,?) ON CONFLICT(category_id, month) DO UPDATE SET amount=excluded.amount',
        b.category_id, b.month, Math.max(0, Math.round(Number(b.amount) || 0)));
      return { ok: true };
    },

    'GET /api/dashboard': (_, __, u) => {
      let m = u.searchParams.get('month');
      if (!monthRe.test(m || '')) m = one('SELECT MAX(substr(date,1,7)) m FROM transactions').m || new Date().toISOString().slice(0, 7);
      return dashboard(m);
    },
  };

  const compiled = Object.entries(routes).map(([k, fn]) => {
    const [method, path] = k.split(' ');
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, n) => (keys.push(n), '(\\d+)')) + '$');
    return { method, re, keys, fn };
  });

  return async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname.startsWith('/api/')) {
        for (const r of compiled) {
          const m = r.method === req.method && u.pathname.match(r.re);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])]));
          let body = {};
          if (req.method !== 'GET' && req.method !== 'DELETE') {
            const chunks = []; let size = 0;
            for await (const c of req) { size += c.length; if (size > 20e6) throw httpErr(413, 'Bestand te groot'); chunks.push(c); }
            const raw = Buffer.concat(chunks).toString('utf8');
            body = raw ? JSON.parse(raw) : {};
          }
          return send(200, await r.fn(body, params, u));
        }
        return send(404, { error: 'Niet gevonden' });
      }
      const rel = u.pathname === '/' ? 'index.html' : normalize(u.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(PUB, rel);
      if (!file.startsWith(PUB)) return send(403, 'Forbidden', 'text/plain');
      try { send(200, await readFile(file), MIME[extname(file)] || 'application/octet-stream'); }
      catch { send(404, 'Not found', 'text/plain'); }
    } catch (e) {
      const code = e.status || (String(e.message).includes('UNIQUE') ? 409 : 500);
      send(code, { error: e.status ? e.message : String(e.message).includes('UNIQUE') ? 'Bestaat al' : e.message });
    }
  };
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const db = openDb(process.env.DB_PATH || 'data/budget.db');
  http.createServer(createHandler(db)).listen(port, '127.0.0.1', () =>
    console.log(`MyBudgets draait op http://localhost:${port}`));
}

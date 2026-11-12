// API-laag: alle routes als functie (methode, pad, body) -> resultaat. Wordt zowel door
// Electron (via IPC) als door de ontwikkel-HTTP-server gebruikt. Leesqueries staan in reports.js.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  importTransactions, recategorize, setCategory, confirmSuggestions, resetAll, loadCategorizer, snapshot, restore, withTx,
} from './db.js';
import { parseRabobankCsv } from './rabobank.js';
import { describeRule, AUTO_THRESHOLD } from './categorizer.js';
import { createClient as createNotionClient } from './notion-api.js';
import { loadTables, guessMapping, buildPlan, applyPlan, buildBudgetPlan, applyBudgetPlan } from './notion.js';
import { createReports, REVIEW, GRP_ORDER } from './reports.js';
import { MONTH_RE as monthRe, httpErr } from './util.js';

export { httpErr };

export function createApi(db, ctx = {}) {
  const R = createReports(db);
  const { q, one, latestMonth, budgetRows, accounts, recurring, dashboard, report, detail, listTransactions, review } = R;
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  // Laatste 30 wijzigingen kunnen ongedaan worden gemaakt (in het geheugen, per sessie)
  const undoStack = new Map(); let undoSeq = 0;
  const withUndo = (ids, fn) => {
    const snap = snapshot(db, ids), res = fn();
    const id = ++undoSeq; undoStack.set(id, snap); if (undoStack.size > 30) undoStack.delete(undoStack.keys().next().value);
    return { ...res, undo: id };
  };
  // Na een handmatige keuze hoeven alleen transacties van dezelfde tegenpartij/IBAN opnieuw te worden bekeken.
  const reclassFor = ids => {
    const get = db.prepare('SELECT merchant, counter_iban FROM transactions WHERE id=?'), rows = ids.map(i => get.get(i)).filter(Boolean);
    return recategorize(db, undefined, { merchants: [...new Set(rows.map(r => r.merchant))], ibans: [...new Set(rows.map(r => r.counter_iban))] });
  };
  // Notion-tabellen cachen we kort (laatste 3 bestanden) zodat het voorbeeld snel blijft bijwerken
  const notionCache = new Map();
  async function notionTables(b) {
    if (b.apiToken) { // rechtstreeks uit Notion (API); 5 minuten gecachet zodat het voorbeeld snel blijft
      const ids = [...(b.databaseIds || [])].sort();
      if (!ids.length) throw httpErr(400, 'Kies minimaal één database');
      const key = 'api:' + createHash('sha1').update(String(b.apiToken) + ids.join(',')).digest('hex'), hit = notionCache.get(key);
      if (hit && Date.now() - hit.at < 5 * 60e3) return hit.tables;
      let tables;
      try { const client = createNotionClient(b.apiToken, ctx.fetch); tables = []; for (const id of ids) tables.push(await client.databaseToTable(id)); }
      catch (e) { throw httpErr(e.status && e.status < 600 ? e.status : 502, e.message); }
      const seen = new Map(); tables.forEach(t => { const n = (seen.get(t.name) || 0) + 1; seen.set(t.name, n); if (n > 1) t.name += ` (${n})`; });
      notionCache.set(key, { at: Date.now(), tables }); if (notionCache.size > 3) notionCache.delete(notionCache.keys().next().value);
      return tables;
    }
    if (!b.base64) throw httpErr(400, 'Geen bestand ontvangen');
    const key = createHash('sha1').update(b.base64).digest('hex');
    if (!notionCache.has(key)) {
      let t; try { t = loadTables(Buffer.from(b.base64, 'base64'), b.name || ''); } catch (e) { throw httpErr(400, e.message); }
      notionCache.set(key, { at: Date.now(), tables: t }); if (notionCache.size > 3) notionCache.delete(notionCache.keys().next().value);
    }
    return notionCache.get(key).tables;
  }
  async function pickTable(b) { const t = (await notionTables(b)).find(x => x.name === b.table); if (!t) throw httpErr(400, 'Tabel niet gevonden in het bestand'); return t; }
  const needCat = id => { if (!one('SELECT 1 FROM categories WHERE id=?', id)) throw httpErr(400, 'Onbekende categorie'); };

  const routes = {
    'GET /api/detail': (_, __, u) => detail(u),
    'GET /api/search': (_, __, u) => {
      const term = (u.searchParams.get('q') || '').trim();
      if (term.length < 2) return { merchants: [], transactions: [] };
      const like = `%${term}%`;
      return {
        merchants: q(`SELECT merchant, MAX(payee) name, COUNT(*) n, SUM(amount) total FROM transactions WHERE (payee LIKE ? OR merchant LIKE ?) AND merchant<>'' GROUP BY merchant ORDER BY n DESC LIMIT 6`, like, like),
        transactions: q(`SELECT id, date, amount, payee, description FROM transactions WHERE payee LIKE ? OR description LIKE ? ORDER BY date DESC LIMIT 6`, like, like),
      };
    },
    'GET /api/categories': () => q(`SELECT c.* FROM categories c ORDER BY CASE c.kind WHEN 'income' THEN 0 WHEN 'expense' THEN 1 ELSE 2 END, ${GRP_ORDER}, c.grp, c.name`),
    'POST /api/categories': b => {
      const c = validCategory(b, true);
      const r = run('INSERT INTO categories (name, kind, color, icon, grp) VALUES (?,?,?,?,?)', c.name, c.kind || 'expense', c.color || '#6b7280', c.icon || '🏷️', c.grp || 'Overig');
      return { id: Number(r.lastInsertRowid) };
    },
    'PUT /api/categories/:id': (b, { id }) => {
      needCat(id);
      const c = validCategory(b, false);
      run('UPDATE categories SET name=COALESCE(?,name), kind=COALESCE(?,kind), color=COALESCE(?,color), icon=COALESCE(?,icon), grp=COALESCE(?,grp), rollover=COALESCE(?,rollover) WHERE id=?',
        c.name ?? null, c.kind ?? null, c.color ?? null, c.icon ?? null, c.grp ?? null, b.rollover == null ? null : (b.rollover ? 1 : 0), id);
      return { ok: true };
    },
    // ?merge=ID verhuist transacties, splitsingen, regels, geheugen en budgetten naar die categorie (zelfde soort) voordat de categorie verdwijnt
    'DELETE /api/categories/:id': (_, { id }, u) => {
      const target = Number(u.searchParams.get('merge')) || null;
      if (target) {
        const from = one('SELECT kind FROM categories WHERE id=?', id), to = one('SELECT kind FROM categories WHERE id=?', target);
        if (!from || !to) throw httpErr(404, 'Categorie niet gevonden');
        if (target === id) throw httpErr(400, 'Kies een andere categorie');
        if (from.kind !== to.kind) throw httpErr(400, 'Samenvoegen kan alleen met een categorie van dezelfde soort');
        withTx(db, () => {
          run('UPDATE transactions SET category_id=? WHERE category_id=?', target, id);
          run('UPDATE splits SET category_id=? WHERE category_id=?', target, id);
          run('UPDATE rules SET category_id=? WHERE category_id=?', target, id);
          for (const m of q('SELECT key, n, label FROM memory WHERE category_id=?', id))
            run('INSERT INTO memory (key, category_id, n, label) VALUES (?,?,?,?) ON CONFLICT(key, category_id) DO UPDATE SET n = n + excluded.n', m.key, target, m.n, m.label);
          run('UPDATE OR IGNORE budgets SET category_id=? WHERE category_id=?', target, id); // bestaand budget van het doel wint
          run('DELETE FROM categories WHERE id=?', id);
        });
        return { ok: true, merged: true };
      }
      run("UPDATE transactions SET confirmed=0, cat_source=NULL, cat_conf=0, cat_reason='' WHERE category_id=?", id);
      run('DELETE FROM categories WHERE id=?', id); recategorize(db); return { ok: true };
    },

    'GET /api/transactions': (_, __, u) => listTransactions(u),
    'GET /api/transactions/:id': (_, { id }) => {
      const t = one('SELECT id, date, amount, payee, description, category_id, cat_source, cat_conf, cat_reason, confirmed, notes, merchant, account_id, counter_iban, code FROM transactions WHERE id=?', id);
      if (!t) throw httpErr(404, 'Transactie niet gevonden');
      return { ...t, splits: q('SELECT category_id, amount, note FROM splits WHERE tx_id=? ORDER BY id', id) };
    },
    'PUT /api/transactions/:id/split': (b, { id }) => {
      const t = one('SELECT amount FROM transactions WHERE id=?', id);
      if (!t) throw httpErr(404, 'Transactie niet gevonden');
      const parts = Array.isArray(b.parts) ? b.parts : [];
      if (parts.length < 2) throw httpErr(400, 'Een splitsing heeft minimaal 2 delen');
      let sum = 0;
      for (const p of parts) {
        if (!Number.isInteger(p.amount) || p.amount === 0 || Math.sign(p.amount) !== Math.sign(t.amount)) throw httpErr(400, 'Elk deel moet hetzelfde teken hebben als de transactie');
        if (p.category_id) needCat(p.category_id); else throw httpErr(400, 'Elk deel heeft een categorie nodig');
        sum += p.amount;
      }
      if (sum !== t.amount) throw httpErr(400, `De delen tellen op tot ${sum / 100}, maar de transactie is ${t.amount / 100}`);
      withTx(db, () => {
        run('DELETE FROM splits WHERE tx_id=?', id);
        const ins = db.prepare('INSERT INTO splits (tx_id, category_id, amount, note) VALUES (?,?,?,?)');
        for (const p of parts) ins.run(id, p.category_id, p.amount, String(p.note || '').slice(0, 200));
        run("UPDATE transactions SET category_id=NULL, cat_source='split', cat_conf=1, cat_reason='Gesplitst', confirmed=1 WHERE id=?", id);
      });
      return { ok: true };
    },
    'DELETE /api/transactions/:id/split': (_, { id }) => {
      run('DELETE FROM splits WHERE tx_id=?', id);
      run("UPDATE transactions SET category_id=NULL, cat_source=NULL, cat_conf=0, cat_reason='', confirmed=0 WHERE id=? AND cat_source='split'", id);
      return { ok: true, changed: recategorize(db) };
    },
    'PATCH /api/transactions/:id': (b, { id }) => {
      const t = one('SELECT * FROM transactions WHERE id=?', id);
      if (!t) throw httpErr(404, 'Transactie niet gevonden');
      if (b.notes !== undefined) run('UPDATE transactions SET notes=? WHERE id=?', String(b.notes).slice(0, 500), id);
      if (!('category_id' in b)) return { ok: true, similar: 0 };
      if (b.category_id) needCat(b.category_id);
      return withUndo([id], () => {
        setCategory(db, [id], b.category_id || null);
        return { ok: true, similar: b.category_id ? reclassFor([id]) : 0 };
      });
    },
    'DELETE /api/transactions/:id': (_, { id }) => { run('DELETE FROM transactions WHERE id=?', id); return { ok: true }; },
    'POST /api/transactions/bulk': b => {
      if (!Array.isArray(b.ids) || !b.ids.length) throw httpErr(400, 'Geen transacties geselecteerd');
      if (b.category_id) needCat(b.category_id);
      return withUndo(b.ids, () => {
        const n = setCategory(db, b.ids, b.category_id || null);
        return { ok: true, updated: n, similar: b.category_id ? reclassFor(b.ids) : 0 };
      });
    },
    'POST /api/transactions/confirm': b => withUndo(b.ids || [], () => ({ confirmed: confirmSuggestions(db, b.ids || []), similar: reclassFor(b.ids || []) })),
    'POST /api/undo': b => {
      const snap = undoStack.get(Number(b.id));
      if (!snap) throw httpErr(404, 'Er is niets meer om ongedaan te maken');
      undoStack.delete(Number(b.id));
      return { ok: true, restored: snap.rows.length, changed: restore(db, snap) };
    },

    'GET /api/review': () => review(),
    'POST /api/recategorize': () => ({ changed: recategorize(db) }),

    'POST /api/import': b => {
      // Bij voorkeur de originele bytes (base64), zodat de codering betrouwbaar wordt herkend.
      let parsed;
      try { parsed = parseRabobankCsv(b.base64 ? Buffer.from(String(b.base64), 'base64') : String(b.csv ?? ''), { fileName: b.name }); }
      catch (e) { throw httpErr(400, e.message); }
      if (!parsed.transactions.length) throw httpErr(400, parsed.skippedRows.length
        ? `Geen bruikbare transacties. Eerste probleem: regel ${parsed.skippedRows[0].row}: ${parsed.skippedRows[0].reason}` : 'Geen transacties gevonden in het bestand');
      const r = importTransactions(db, parsed.transactions.map(t => t.tx), { name: b.name });
      return { ...r, skipped: r.skipped + parsed.duplicateRows.length, duplicatesInFile: parsed.duplicateRows.length,
        rowsInFile: parsed.rowsInFile, problems: parsed.skippedRows.slice(0, 20), problemCount: parsed.skippedRows.length,
        warnings: parsed.detection.warnings.slice(0, 10), encoding: parsed.detection.encoding, separator: parsed.detection.separator };
    },
    // ---- Notion-import: analyseren, voorbeeld (plan) en uitvoeren. Stateless: het bestand gaat elke keer mee (gecachet).
    'POST /api/notion/api/databases': async b => {
      try { return { databases: await createNotionClient(b.token, ctx.fetch).listDatabases() }; }
      catch (e) { throw httpErr(e.status && e.status < 600 ? e.status : 502, e.message); }
    },
    'POST /api/notion/analyze': async b => {
      const tables = await notionTables(b);
      return { tables: tables.map(t => { const g = guessMapping(t); return { name: t.name, rows: t.rows.length, headers: t.headers, guess: g, samples: t.rows.slice(0, 6) }; }) };
    },
    'POST /api/notion/plan': async b => {
      const t = await pickTable(b);
      try {
        if (b.kind === 'budgets') { const p = buildBudgetPlan(db, t, b.config || {}); return { kind: 'budgets', summary: p.summary, errors: p.errors.slice(0, 15), items: p.items.slice(0, 40) }; }
        const p = buildPlan(db, t, b.config || {}); return { kind: 'transactions', summary: p.summary, preview: p.preview, errors: p.errors.slice(0, 15), categoryPlan: p.categoryPlan };
      } catch (e) { throw httpErr(400, e.message); }
    },
    'POST /api/notion/import': async b => {
      const t = await pickTable(b);
      try {
        if (b.kind === 'budgets') return { kind: 'budgets', ...applyBudgetPlan(db, buildBudgetPlan(db, t, b.config || {})) };
        return { kind: 'transactions', ...applyPlan(db, buildPlan(db, t, b.config || {}), { name: b.name || t.name }) };
      } catch (e) { throw e.status ? e : httpErr(400, e.message); }
    },
    'POST /api/demo': () => {
      if (!ctx.demoCSV) throw httpErr(400, 'Geen voorbeelddata beschikbaar');
      return importTransactions(db, parseRabobankCsv(ctx.demoCSV()).transactions.map(t => t.tx), { name: 'Voorbeelddata' });
    },

    'GET /api/rules': () => q(`SELECT r.*, c.name category, c.icon FROM rules r JOIN categories c ON c.id=r.category_id ORDER BY r.priority DESC, c.name, r.pattern`)
      .map(r => ({ ...r, description: describeRule(r) })),
    'POST /api/rules': b => {
      const r = validRule(b);
      const res = run(`INSERT INTO rules (field, op, pattern, direction, amount_min, amount_max, priority, enabled, category_id) VALUES (?,?,?,?,?,?,?,?,?)`,
        r.field, r.op, r.pattern, r.direction, r.amount_min, r.amount_max, r.priority, r.enabled, r.category_id);
      return { id: Number(res.lastInsertRowid), recategorized: recategorize(db) };
    },
    'PUT /api/rules/:id': (b, { id }) => {
      const r = validRule(b);
      run(`UPDATE rules SET field=?, op=?, pattern=?, direction=?, amount_min=?, amount_max=?, priority=?, enabled=?, category_id=? WHERE id=?`,
        r.field, r.op, r.pattern, r.direction, r.amount_min, r.amount_max, r.priority, r.enabled, r.category_id, id);
      return { ok: true, recategorized: recategorize(db) };
    },
    'DELETE /api/rules/:id': (_, { id }) => { run('DELETE FROM rules WHERE id=?', id); return { ok: true, recategorized: recategorize(db) }; },
    'POST /api/rules/preview': b => {
      const r = validRule({ ...b, category_id: b.category_id || 1 });
      const cz = loadCategorizer(db), hits = [];
      const rows = q('SELECT id, payee, description, amount, counter_iban, date FROM transactions ORDER BY date DESC');
      let n = 0; for (const t of rows) if (cz.matchRule({ ...r, id: 0 }, t)) { n++; if (hits.length < 6) hits.push(t); }
      return { count: n, samples: hits };
    },

    // Regelsuggesties: tegenpartijen die je ≥3× consequent hetzelfde hebt ingedeeld en waar nog geen regel voor bestaat
    'GET /api/rules/suggest': () => {
      const have = q('SELECT pattern FROM rules WHERE enabled=1').map(r => r.pattern.toLowerCase());
      return q(`SELECT m.key, m.label, m.n, m.category_id, c.name category, c.icon FROM memory m JOIN categories c ON c.id=m.category_id
        WHERE m.key LIKE 'm:%' AND m.n>=3 AND m.label<>'' AND (SELECT COUNT(*) FROM memory x WHERE x.key=m.key)=1 ORDER BY m.n DESC LIMIT 30`)
        .filter(r => !have.some(p => p && r.label.toLowerCase().includes(p))).slice(0, 8);
    },
    'GET /api/imports': () => q(`SELECT i.id, i.name, i.created, i.from_date, i.to_date, (SELECT COUNT(*) FROM transactions t WHERE t.import_id=i.id) n FROM imports i ORDER BY i.id DESC LIMIT 50`),
    // Een hele import terugdraaien: verwijdert de bijbehorende transacties (en splitsingen); handmatige keuzes daarvan vervallen mee
    'DELETE /api/imports/:id': (_, { id }) => {
      const n = one('SELECT COUNT(*) c FROM transactions WHERE import_id=?', id).c;
      withTx(db, () => { run('DELETE FROM transactions WHERE import_id=?', id); run('DELETE FROM imports WHERE id=?', id); });
      recategorize(db);
      return { ok: true, deleted: n };
    },
    // Hoe is de categorisering tot stand gekomen? (transparantie in "Hoe werkt het?")
    'GET /api/stats': () => {
      const bySource = Object.fromEntries(q(`SELECT CASE WHEN confirmed=0 AND category_id IS NOT NULL AND cat_conf < ${AUTO_THRESHOLD - 0.001} THEN 'suggested' ELSE COALESCE(cat_source,'none') END s, COUNT(*) n FROM transactions GROUP BY s`).map(r => [r.s, r.n]));
      const total = Object.values(bySource).reduce((a, b) => a + b, 0);
      const review = one(`SELECT COUNT(*) c FROM transactions t WHERE ${REVIEW}`).c;
      return { total, review, bySource, rules: one('SELECT COUNT(*) c FROM rules WHERE enabled=1').c, memory: one('SELECT COUNT(*) c FROM memory').c };
    },
    'GET /api/goals': () => q('SELECT * FROM goals ORDER BY id'),
    'POST /api/goals': b => {
      if (!String(b.name || '').trim() || !(Number(b.target) > 0)) throw httpErr(400, 'Naam en streefbedrag zijn verplicht');
      const r = run('INSERT INTO goals (name, icon, target, saved, monthly) VALUES (?,?,?,?,?)', String(b.name).trim(), b.icon || '🎯', Math.round(b.target), Math.max(0, Math.round(b.saved || 0)), Math.max(0, Math.round(b.monthly || 0)));
      return { id: Number(r.lastInsertRowid) };
    },
    'PUT /api/goals/:id': (b, { id }) => {
      if (b.target != null && !(Number(b.target) > 0)) throw httpErr(400, 'Het streefbedrag moet groter dan 0 zijn');
      if (b.name != null && !String(b.name).trim()) throw httpErr(400, 'Naam is verplicht');
      run('UPDATE goals SET name=COALESCE(?,name), icon=COALESCE(?,icon), target=COALESCE(?,target), saved=COALESCE(?,saved), monthly=COALESCE(?,monthly) WHERE id=?',
        b.name ?? null, b.icon ?? null, b.target != null ? Math.round(b.target) : null, b.saved != null ? Math.max(0, Math.round(b.saved)) : null, b.monthly != null ? Math.max(0, Math.round(b.monthly)) : null, id);
      return { ok: true };
    },
    'DELETE /api/goals/:id': (_, { id }) => { run('DELETE FROM goals WHERE id=?', id); return { ok: true }; },
    'GET /api/memory': () => q(`SELECT m.key, m.n, m.label, m.category_id, c.name category, c.icon FROM memory m JOIN categories c ON c.id=m.category_id ORDER BY m.n DESC, m.label LIMIT 500`),
    'DELETE /api/memory': (_, __, u) => { run('DELETE FROM memory WHERE key=?', u.searchParams.get('key') || ''); return { ok: true, changed: recategorize(db) }; },

    'GET /api/accounts': () => accounts(),
    // Hernoemen raakt de indeling niet; alleen de uitleg bij gekoppelde overboekingen noemt de rekeningnaam
    'PUT /api/accounts/:id': (b, { id }) => { run('UPDATE accounts SET name=? WHERE id=?', String(b.name || '').trim().slice(0, 80) || 'Rekening', id); return { ok: true }; },

    'GET /api/budget': (_, __, u) => {
      const m = u.searchParams.get('month');
      if (!monthRe.test(m || '')) throw httpErr(400, 'month=YYYY-MM vereist');
      return budgetRows(m);
    },
    'PUT /api/budget': b => {
      if (!monthRe.test(b.month || '') || !b.category_id) throw httpErr(400, 'month en category_id vereist');
      needCat(b.category_id);
      run('INSERT INTO budgets (category_id, month, amount) VALUES (?,?,?) ON CONFLICT(category_id, month) DO UPDATE SET amount=excluded.amount',
        b.category_id, b.month, Math.max(0, Math.round(Number(b.amount) || 0)));
      return { ok: true };
    },
    'POST /api/budget/fill': b => { // vul lege budgetten met het gemiddelde van de laatste 3 maanden (afgerond op € 5)
      if (!monthRe.test(b.month || '')) throw httpErr(400, 'month vereist');
      let n = 0;
      for (const r of budgetRows(b.month)) if (!r.budget && r.avg3 >= 500) {
        run('INSERT OR REPLACE INTO budgets (category_id, month, amount) VALUES (?,?,?)', r.id, b.month, Math.round(r.avg3 / 500) * 500); n++;
      }
      return { filled: n };
    },
    'POST /api/budget/copy': b => {
      if (!monthRe.test(b.from || '') || !monthRe.test(b.to || '')) throw httpErr(400, 'from/to vereist');
      let n = 0; for (const r of budgetRows(b.from)) if (r.budget) { run('INSERT OR REPLACE INTO budgets (category_id, month, amount) VALUES (?,?,?)', r.id, b.to, r.budget); n++; }
      return { copied: n };
    },

    'GET /api/dashboard': (_, __, u) => { let m = u.searchParams.get('month'); if (!monthRe.test(m || '')) m = latestMonth(); return dashboard(m); },
    'GET /api/report': (_, __, u) => { let m = u.searchParams.get('month'); if (!monthRe.test(m || '')) m = latestMonth(); return report(m, Math.min(24, Number(u.searchParams.get('months')) || 12)); },
    'GET /api/recurring': () => recurring(),
    // "Geen vaste last": zet een foutief herkende terugkerende betaling weg (en herstel)
    'GET /api/recurring/ignored': () => q('SELECT merchant, name FROM ignored_recurring ORDER BY name'),
    'POST /api/recurring/ignore': b => {
      if (!b.merchant) throw httpErr(400, 'merchant vereist');
      if (b.ignore === false) run('DELETE FROM ignored_recurring WHERE merchant=?', b.merchant);
      else run('INSERT OR REPLACE INTO ignored_recurring (merchant, name) VALUES (?,?)', b.merchant, String(b.name || b.merchant));
      return { ok: true };
    },
    'GET /api/export': () => {
      const rows = q(`SELECT t.date, t.amount, t.payee, t.description, COALESCE(c.name,'') cat, t.account, t.counter_iban, t.notes FROM transactions t LEFT JOIN categories c ON c.id=t.category_id ORDER BY t.date, t.id`);
      const qt = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      return { csv: ['Datum;Bedrag;Tegenpartij;Omschrijving;Categorie;Rekening;Tegenrekening;Notities', ...rows.map(r =>
        [r.date, (r.amount / 100).toFixed(2).replace('.', ','), r.payee, r.description, r.cat, r.account, r.counter_iban, r.notes].map(qt).join(';'))].join('\n') };
    },
    'POST /api/reset': b => { if (b.confirm !== 'WISSEN') throw httpErr(400, 'Bevestiging ontbreekt'); resetAll(db); return { ok: true }; },
  };

  // Categorie-invoer: verplichte naam bij aanmaken, geldige soort, nette lengtes. Ontbrekende velden blijven undefined.
  function validCategory(b, creating) {
    const out = {};
    if (creating || b.name != null) { out.name = String(b.name ?? '').trim().slice(0, 60); if (!out.name) throw httpErr(400, 'Naam ontbreekt'); }
    if (b.kind != null) { if (!['expense', 'income', 'transfer'].includes(b.kind)) throw httpErr(400, 'Ongeldige soort'); out.kind = b.kind; }
    if (b.color != null) { if (!/^#[0-9a-f]{6}$/i.test(b.color)) throw httpErr(400, 'Ongeldige kleur'); out.color = b.color; }
    if (b.icon != null) out.icon = String(b.icon).trim().slice(0, 8) || '🏷️';
    if (b.grp != null) out.grp = String(b.grp).trim().slice(0, 40) || 'Overig';
    return out;
  }

  function validRule(b) {
    const category_id = Number(b.category_id); needCat(category_id);
    const num = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
    const r = {
      field: ['any', 'payee', 'description', 'iban'].includes(b.field) ? b.field : 'any',
      op: ['contains', 'equals', 'startswith', 'regex'].includes(b.op) ? b.op : 'contains',
      pattern: String(b.pattern ?? '').trim(), direction: ['any', 'in', 'out'].includes(b.direction) ? b.direction : 'any',
      amount_min: num(b.amount_min), amount_max: num(b.amount_max), priority: num(b.priority) ?? 0, enabled: b.enabled === 0 || b.enabled === false ? 0 : 1, category_id,
    };
    if (!r.pattern && r.amount_min == null && r.amount_max == null && r.direction === 'any') throw httpErr(400, 'Geef een tekst, bedrag of richting op');
    if (r.op === 'regex') { try { new RegExp(r.pattern); } catch { throw httpErr(400, 'Ongeldige reguliere expressie'); } }
    return r;
  }

  const compiled = Object.entries(routes).map(([k, fn]) => {
    const [method, path] = k.split(' '), keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, n) => (keys.push(n), '(\\d+)')) + '$');
    return { method, re, keys, fn };
  });

  // Hoofdingang: (methode, pad+query, body) -> resultaat
  return async function dispatch(method, url, body = {}) {
    const u = new URL(url, 'http://local');
    for (const r of compiled) {
      const m = r.method === method && u.pathname.match(r.re);
      if (!m) continue;
      try { return await r.fn(body, Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])])), u); }
      catch (e) {
        if (e.status) throw e;
        if (String(e.message).includes('UNIQUE')) throw httpErr(409, 'Bestaat al');
        throw e;
      }
    }
    throw httpErr(404, 'Niet gevonden');
  };
}

export const demoCSVFrom = path => () => readFileSync(path, 'utf8');

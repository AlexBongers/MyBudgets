// API-laag: alle routes als pure functie (methode, pad, body) -> resultaat. Wordt zowel door
// Electron (via IPC) als door de ontwikkel-HTTP-server gebruikt.
import { readFileSync } from 'node:fs';
import {
  AUTO_THRESHOLD, importTransactions, recategorize, setCategory, confirmSuggestions, resetAll, loadCategorizer, snapshot, restore,
} from './db.js';
import { parseRabobankCsv } from './rabobank.js';
import { detectRecurring } from './recurring.js';
import { describeRule } from './categorizer.js';

const monthRe = /^\d{4}-\d{2}$/;
const REVIEW = `t.confirmed=0 AND (t.category_id IS NULL OR t.cat_conf < ${AUTO_THRESHOLD - 0.001})`;
const GRP_ORDER = "CASE c.grp WHEN 'Inkomen' THEN 0 WHEN 'Wonen' THEN 1 WHEN 'Dagelijks' THEN 2 WHEN 'Vervoer' THEN 3 WHEN 'Zorg & verzekeringen' THEN 4 WHEN 'Vrije tijd' THEN 5 WHEN 'Overig' THEN 6 WHEN 'Overboekingen' THEN 8 ELSE 7 END";
const EXPENSE = "(c.kind='expense' OR (c.id IS NULL AND t.amount<0))";
const INCOME = "(c.kind='income' OR (c.id IS NULL AND t.amount>0))";
export const httpErr = (status, message) => Object.assign(new Error(message), { status });
const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
const daysIn = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
const eur = c => (c / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: Math.abs(c) >= 10000 ? 0 : 2 });

export function createApi(db, ctx = {}) {
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const latestMonth = () => one('SELECT MAX(substr(date,1,7)) m FROM transactions').m || new Date().toISOString().slice(0, 7);
  // Laatste 30 wijzigingen kunnen ongedaan worden gemaakt (in het geheugen, per sessie)
  const undoStack = new Map(); let undoSeq = 0;
  const withUndo = (ids, fn) => {
    const snap = snapshot(db, ids), res = fn();
    const id = ++undoSeq; undoStack.set(id, snap); if (undoStack.size > 30) undoStack.delete(undoStack.keys().next().value);
    return { ...res, undo: id };
  };
  const needCat = id => { if (!one('SELECT 1 FROM categories WHERE id=?', id)) throw httpErr(400, 'Onbekende categorie'); };

  function monthTotals(m) {
    return one(`SELECT
      COALESCE(SUM(CASE WHEN ${INCOME} THEN t.amount END),0) AS income,
      COALESCE(-SUM(CASE WHEN ${EXPENSE} THEN t.amount END),0) AS expenses
      FROM tl t LEFT JOIN categories c ON c.id=t.category_id WHERE substr(t.date,1,7)=?`, m);
  }
  function spentByCat(m) {
    return Object.fromEntries(q(`SELECT category_id c, -SUM(amount) s FROM tl WHERE substr(date,1,7)=? AND category_id IS NOT NULL GROUP BY category_id`, m).map(r => [r.c, r.s]));
  }
  function budgetRows(m) {
    const spent = spentByCat(m);
    const avg = Object.fromEntries(q(`SELECT category_id c, -SUM(amount)/3.0 a FROM tl WHERE substr(date,1,7) IN (?,?,?) AND category_id IS NOT NULL GROUP BY category_id`,
      addMonths(m, -1), addMonths(m, -2), addMonths(m, -3)).map(r => [r.c, Math.round(r.a)]));
    return q(`SELECT c.id, c.name, c.color, c.icon, c.grp,
        (SELECT amount FROM budgets b WHERE b.category_id=c.id AND b.month<=? ORDER BY month DESC LIMIT 1) AS budget,
        EXISTS(SELECT 1 FROM budgets b WHERE b.category_id=c.id AND b.month=?) AS explicit
      FROM categories c WHERE c.kind='expense' ORDER BY ${GRP_ORDER}, c.grp, c.name`, m, m)
      .map(r => ({ ...r, budget: r.budget ?? 0, explicit: !!r.explicit, spent: spent[r.id] ?? 0, avg3: Math.max(0, avg[r.id] ?? 0) }));
  }
  function accounts() {
    return q('SELECT * FROM accounts ORDER BY id').map(a => {
      const last = one('SELECT balance, date FROM transactions WHERE account_id=? AND balance IS NOT NULL ORDER BY date DESC, seq DESC, id DESC LIMIT 1', a.id);
      const n = one('SELECT COUNT(*) c, MIN(date) f, MAX(date) t FROM transactions WHERE account_id=?', a.id);
      return { ...a, balance: last?.balance ?? null, balance_date: last?.date ?? null, count: n.c, from: n.f, to: n.t };
    });
  }
  function recurring() {
    const rows = q(`SELECT t.merchant, t.payee, t.date, t.amount, t.category_id FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
      WHERE t.amount<0 AND (c.id IS NULL OR (c.kind='expense' AND COALESCE(c.key,'') NOT IN ('groceries','dining','drugstore','fuel','shopping','cash','transit','leisure'))) AND t.merchant<>'' AND t.date >= date((SELECT MAX(date) FROM transactions), '-18 months')`);
    const latest = one('SELECT MAX(date) d FROM transactions').d;
    return latest ? detectRecurring(rows, latest) : [];
  }

  function insights(m, d) {
    const out = [], { totals, prevTotals } = d;
    if (prevTotals.expenses > 0 && totals.expenses > 0) {
      const diff = totals.expenses - prevTotals.expenses, pct = Math.round(Math.abs(diff) / prevTotals.expenses * 100);
      if (pct >= 3) out.push({ type: diff > 0 ? 'warn' : 'good', text: `Je gaf ${eur(Math.abs(diff))} (${pct}%) ${diff > 0 ? 'meer' : 'minder'} uit dan vorige maand.` });
    }
    const up = d.byCategory.map(c => ({ ...c, diff: c.value - (c.prev || 0) })).filter(c => c.diff > 2000 && c.prev > 0).sort((a, b) => b.diff - a.diff)[0];
    if (up) out.push({ type: 'info', text: `Grootste stijging: ${up.icon} ${up.name} (+${eur(up.diff)} t.o.v. vorige maand).` });
    for (const b of d.budget) {
      if (b.budget > 0 && b.spent > b.budget) out.push({ type: 'warn', text: `${b.icon} ${b.name} staat ${eur(b.spent - b.budget)} boven budget.` });
      else if (b.budget > 0 && b.spent > b.budget * 0.85) out.push({ type: 'info', text: `${b.icon} ${b.name}: ${Math.round(b.spent / b.budget * 100)}% van het budget is besteed.` });
    }
    if (d.projection) {
      const tb = d.budget.reduce((a, b) => a + b.budget, 0);
      out.push({ type: tb && d.projection.expenses > tb ? 'warn' : 'info', text: `Op dit tempo kom je uit op ${eur(d.projection.expenses)} aan uitgaven${tb ? ` (budget ${eur(tb)})` : ''}.` });
    }
    const big = one(`SELECT t.payee, -t.amount a FROM tl t LEFT JOIN categories c ON c.id=t.category_id WHERE substr(t.date,1,7)=? AND ${EXPENSE} ORDER BY t.amount LIMIT 1`, m);
    if (big) out.push({ type: 'info', text: `Grootste uitgave: ${big.payee} (${eur(big.a)}).` });
    if (totals.income > 0) {
      const rate = Math.round((totals.income - totals.expenses) / totals.income * 100);
      out.push({ type: rate >= 10 ? 'good' : rate < 0 ? 'warn' : 'info', text: rate < 0 ? `Je gaf ${eur(totals.expenses - totals.income)} meer uit dan je verdiende.` : `Je spaarquote is ${rate}%.` });
    }
    const fixed = d.recurringMonthly;
    if (fixed > 0 && totals.income > 0) out.push({ type: 'info', text: `Vaste lasten: ca. ${eur(fixed)} per maand (${Math.round(fixed / totals.income * 100)}% van je inkomen).` });
    return out.slice(0, 7);
  }

  function dashboard(m) {
    const totals = monthTotals(m), prevMonth = addMonths(m, -1), prevTotals = monthTotals(prevMonth);
    const prevSpent = spentByCat(prevMonth);
    const byCategory = q(`SELECT c.id, COALESCE(c.name,'Niet gecategoriseerd') name, COALESCE(c.color,'#9ca3af') color, COALESCE(c.icon,'❔') icon, -SUM(t.amount) value
      FROM tl t LEFT JOIN categories c ON c.id=t.category_id WHERE substr(t.date,1,7)=? AND ${EXPENSE} GROUP BY c.id HAVING value > 0 ORDER BY value DESC`, m)
      .map(c => ({ ...c, prev: prevSpent[c.id] ?? 0 }));
    const trend = []; for (let i = 11; i >= 0; i--) { const mm = addMonths(m, -i); trend.push({ month: mm, ...monthTotals(mm) }); }
    const topPayees = q(`SELECT MAX(t.payee) payee, t.merchant, MAX(COALESCE(c.icon,'❔')) icon, -SUM(t.amount) value, COUNT(*) n
      FROM tl t LEFT JOIN categories c ON c.id=t.category_id WHERE substr(t.date,1,7)=? AND ${EXPENSE} GROUP BY t.merchant HAVING value > 0 ORDER BY value DESC LIMIT 8`, m);
    const budget = budgetRows(m).filter(b => b.budget > 0 || b.spent > 0);
    // cumulatieve uitgaven per dag (deze + vorige maand)
    const cum = mm => {
      const n = daysIn(mm), per = Array(n + 1).fill(0);
      q(`SELECT CAST(substr(t.date,9,2) AS INTEGER) d, -SUM(t.amount) v FROM tl t LEFT JOIN categories c ON c.id=t.category_id
        WHERE substr(t.date,1,7)=? AND ${EXPENSE} GROUP BY d`, mm).forEach(r => { per[r.d] = r.v; });
      let s = 0; return per.slice(1).map(v => (s += v));
    };
    const today = new Date().toISOString().slice(0, 10);
    const isCurrent = today.slice(0, 7) === m, dim = daysIn(m);
    const cumul = { month: cum(m), prev: cum(prevMonth), days: dim };
    if (isCurrent) cumul.month = cumul.month.slice(0, +today.slice(8, 10));
    const rec = recurring().filter(r => r.active);
    let projection = null;
    if (isCurrent && totals.expenses > 0) {
      // vaste lasten: wat al betaald is + wat nog verwacht wordt; variabel: huidig tempo
      const dom = +today.slice(8, 10), mset = new Set(rec.map(r => r.merchant));
      const paid = q(`SELECT t.merchant, -SUM(t.amount) v FROM tl t WHERE substr(t.date,1,7)=? AND t.amount<0 GROUP BY t.merchant`, m)
        .filter(r => mset.has(r.merchant));
      const paidSet = new Set(paid.map(r => r.merchant)), paidSum = paid.reduce((a, r) => a + r.v, 0);
      const remaining = rec.filter(r => !paidSet.has(r.merchant) && r.next.slice(0, 7) === m && r.next > today).reduce((a, r) => a + r.amount, 0);
      projection = { expenses: Math.round(paidSum + remaining + (totals.expenses - paidSum) / dom * dim) };
    }
    const recurringMonthly = rec.reduce((a, r) => a + r.monthly, 0);
    const d = {
      month: m, totals, prevTotals, byCategory, trend, topPayees, budget, cumul, projection, recurringMonthly,
      review: one(`SELECT COUNT(*) c FROM transactions t WHERE ${REVIEW}`).c,
      months: q('SELECT DISTINCT substr(date,1,7) m FROM transactions ORDER BY m DESC').map(r => r.m),
      accounts: accounts(), txCount: one('SELECT COUNT(*) c FROM transactions').c,
    };
    d.insights = insights(m, d);
    return d;
  }

  function listTransactions(u) {
    const p = u.searchParams, where = [], args = [];
    const month = p.get('month');
    if (month && monthRe.test(month)) { where.push('substr(t.date,1,7)=?'); args.push(month); }
    if (p.get('status') === 'review') where.push(REVIEW);
    if (p.get('status') === 'uncategorized') where.push('t.category_id IS NULL');
    if (p.get('category') === 'none') where.push('t.category_id IS NULL');
    else if (p.get('category')) { where.push('(t.category_id=? OR EXISTS (SELECT 1 FROM splits s WHERE s.tx_id=t.id AND s.category_id=?))'); args.push(Number(p.get('category')), Number(p.get('category'))); }
    if (p.get('account')) { where.push('t.account_id=?'); args.push(Number(p.get('account'))); }
    if (p.get('merchant')) { where.push('t.merchant=?'); args.push(p.get('merchant')); }
    if (p.get('type') === 'in') where.push('t.amount>0'); if (p.get('type') === 'out') where.push('t.amount<0');
    if (p.get('q')) { const like = `%${p.get('q')}%`; where.push('(t.payee LIKE ? OR t.description LIKE ? OR t.notes LIKE ? OR t.counter_iban LIKE ?)'); args.push(like, like, like, like); }
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sort = { date: 't.date', amount: 't.amount', payee: 't.payee COLLATE NOCASE' }[p.get('sort')] || 't.date';
    const dir = p.get('dir') === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Number(p.get('limit')) || 300, 2000), offset = Number(p.get('offset')) || 0;
    const rows = q(`SELECT t.id, t.date, t.amount, t.payee, t.description, t.category_id, t.cat_source, t.cat_conf, t.cat_reason,
        t.confirmed, t.notes, t.merchant, t.account_id, t.counter_iban, t.code, (SELECT COUNT(*) FROM splits s WHERE s.tx_id=t.id) split_count
      FROM transactions t ${W} ORDER BY ${sort} ${dir}, t.id DESC LIMIT ${limit} OFFSET ${offset}`, ...args);
    const agg = one(`SELECT COUNT(*) n, COALESCE(SUM(t.amount),0) sum FROM transactions t ${W}`, ...args);
    return { rows, total: agg.n, sum: agg.sum };
  }

  function review() {
    const rows = q(`SELECT t.id, t.date, t.amount, t.payee, t.description, t.merchant, t.category_id, t.cat_source, t.cat_conf, t.cat_reason
      FROM transactions t WHERE ${REVIEW} ORDER BY t.date DESC`);
    const groups = new Map();
    for (const r of rows) {
      let g = groups.get(r.merchant);
      if (!g) groups.set(r.merchant, g = { merchant: r.merchant, name: r.payee, count: 0, total: 0, ids: [], samples: [], suggestions: new Map(), last: r.date, positive: 0 });
      g.count++; g.total += r.amount; g.ids.push(r.id); if (r.amount > 0) g.positive++;
      if (g.samples.length < 3) g.samples.push({ date: r.date, amount: r.amount, description: r.description });
      if (r.category_id) { const s = g.suggestions.get(r.category_id) || { category_id: r.category_id, n: 0, conf: 0, reason: r.cat_reason, source: r.cat_source }; s.n++; s.conf = Math.max(s.conf, r.cat_conf); g.suggestions.set(r.category_id, s); }
    }
    return [...groups.values()].map(g => ({ ...g, suggestions: [...g.suggestions.values()].sort((a, b) => b.n - a.n || b.conf - a.conf) }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  }

  function report(m, months) {
    const list = []; for (let i = months - 1; i >= 0; i--) list.push(addMonths(m, -i));
    const from = list[0] + '-01', to = list[list.length - 1] + '-31';
    const cells = q(`SELECT c.id, c.kind, substr(t.date,1,7) mo, SUM(t.amount) v FROM tl t JOIN categories c ON c.id=t.category_id
      WHERE t.date>=? AND t.date<=? AND c.kind<>'transfer' GROUP BY c.id, mo`, from, to);
    const cats = q(`SELECT c.id, c.name, c.kind, c.color, c.icon, c.grp FROM categories c WHERE c.kind<>'transfer' ORDER BY c.kind DESC, ${GRP_ORDER}, c.grp, c.name`);
    const map = {}; cells.forEach(r => { (map[r.id] ||= {})[r.mo] = r.kind === 'income' ? r.v : -r.v; });
    const unc = q(`SELECT substr(date,1,7) mo, SUM(amount) v FROM tl WHERE category_id IS NULL AND date>=? AND date<=? GROUP BY mo`, from, to);
    // inkomen: positieve bedragen; uitgaven: positief = uitgave (terugbetalingen verlagen)
    const rows = cats.map(c => ({ ...c, values: list.map(mo => map[c.id]?.[mo] ?? 0) })).filter(r => r.values.some(v => v !== 0));
    return { months: list, rows, uncategorized: list.map(mo => -(unc.find(u => u.mo === mo)?.v ?? 0)), totals: list.map(mo => monthTotals(mo)) };
  }

  function detail(u) {
    const p = u.searchParams; let m = p.get('month'); if (!monthRe.test(m || '')) m = latestMonth();
    const n = Math.min(24, Number(p.get('months')) || 12), list = []; for (let i = n - 1; i >= 0; i--) list.push(addMonths(m, -i));
    const from = list[0] + '-01', to = list[n - 1] + '-31';
    let where, args, head, kind = 'expense';
    if (p.get('category')) {
      const c = one('SELECT * FROM categories WHERE id=?', Number(p.get('category')));
      if (!c) throw httpErr(404, 'Categorie niet gevonden');
      where = 't.category_id=?'; args = [c.id]; kind = c.kind; head = { type: 'category', id: c.id, title: c.name, icon: c.icon, color: c.color, group: c.grp, kind: c.kind };
    } else if (p.get('merchant')) {
      const t = one('SELECT payee, category_id FROM tl WHERE merchant=? ORDER BY date DESC LIMIT 1', p.get('merchant'));
      if (!t) throw httpErr(404, 'Tegenpartij niet gevonden');
      where = 't.merchant=?'; args = [p.get('merchant')];
      head = { type: 'merchant', merchant: p.get('merchant'), title: t.payee, icon: '🏪', color: '#6b7280' };
    } else throw httpErr(400, 'category of merchant vereist');
    const rows = q(`SELECT substr(t.date,1,7) mo, SUM(t.amount) v, COUNT(*) n FROM tl t WHERE ${where} AND t.date>=? AND t.date<=? GROUP BY mo`, ...args, from, to);
    const net = rows.reduce((a, r) => a + r.v, 0), sign = kind === 'income' || (head.type === 'merchant' && net > 0) ? 1 : -1;
    const by = Object.fromEntries(rows.map(r => [r.mo, r.v * sign]));
    const monthly = list.map(mo => ({ month: mo, value: by[mo] ?? 0 }));
    const total = monthly.reduce((a, r) => a + r.value, 0), count = rows.reduce((a, r) => a + r.n, 0);
    const active = monthly.filter(r => r.value !== 0).length;
    const biggest = one(`SELECT t.payee, t.date, t.amount FROM tl t WHERE ${where} AND t.date>=? AND t.date<=? ORDER BY ${sign === 1 ? 't.amount DESC' : 't.amount ASC'} LIMIT 1`, ...args, from, to);
    const merchants = head.type === 'category' ? q(`SELECT t.merchant, MAX(t.payee) name, SUM(t.amount)*? v, COUNT(*) n FROM tl t WHERE ${where} AND t.date>=? AND t.date<=? GROUP BY t.merchant ORDER BY v DESC LIMIT 10`, sign, ...args, from, to) : [];
    const categories = head.type === 'merchant' ? q(`SELECT c.id, COALESCE(c.name,'Zonder categorie') name, COALESCE(c.icon,'❔') icon, COALESCE(c.color,'#9ca3af') color, SUM(t.amount)*? v, COUNT(*) n FROM tl t LEFT JOIN categories c ON c.id=t.category_id WHERE ${where} AND t.date>=? AND t.date<=? GROUP BY c.id ORDER BY v DESC`, sign, ...args, from, to) : [];
    const recent = q(`SELECT t.id, t.date, t.amount, t.payee, t.description, t.category_id FROM tl t WHERE ${where} ORDER BY t.date DESC, t.id DESC LIMIT 12`, ...args);
    const first = one(`SELECT MIN(t.date) d FROM tl t WHERE ${where}`, ...args).d;
    return { ...head, months: list, monthly, total, count, avg: Math.round(total / n), avgActive: active ? Math.round(total / active) : 0, active, biggest, merchants, categories, recent, first, sign };
  }

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
      if (!b.name?.trim()) throw httpErr(400, 'Naam ontbreekt');
      const r = run('INSERT INTO categories (name, kind, color, icon, grp) VALUES (?,?,?,?,?)', b.name.trim(), b.kind || 'expense', b.color || '#6b7280', b.icon || '🏷️', b.grp || 'Overig');
      return { id: Number(r.lastInsertRowid) };
    },
    'PUT /api/categories/:id': (b, { id }) => {
      run('UPDATE categories SET name=COALESCE(?,name), kind=COALESCE(?,kind), color=COALESCE(?,color), icon=COALESCE(?,icon), grp=COALESCE(?,grp) WHERE id=?',
        b.name?.trim() ?? null, b.kind ?? null, b.color ?? null, b.icon ?? null, b.grp ?? null, id);
      return { ok: true };
    },
    'DELETE /api/categories/:id': (_, { id }) => {
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
      db.exec('BEGIN');
      try {
        run('DELETE FROM splits WHERE tx_id=?', id);
        const ins = db.prepare('INSERT INTO splits (tx_id, category_id, amount, note) VALUES (?,?,?,?)');
        for (const p of parts) ins.run(id, p.category_id, p.amount, String(p.note || '').slice(0, 200));
        run("UPDATE transactions SET category_id=NULL, cat_source='split', cat_conf=1, cat_reason='Gesplitst', confirmed=1 WHERE id=?", id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
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
        return { ok: true, similar: b.category_id ? recategorize(db) : 0 };
      });
    },
    'DELETE /api/transactions/:id': (_, { id }) => { run('DELETE FROM transactions WHERE id=?', id); return { ok: true }; },
    'POST /api/transactions/bulk': b => {
      if (!Array.isArray(b.ids) || !b.ids.length) throw httpErr(400, 'Geen transacties geselecteerd');
      if (b.category_id) needCat(b.category_id);
      return withUndo(b.ids, () => {
        const n = setCategory(db, b.ids, b.category_id || null);
        return { ok: true, updated: n, similar: b.category_id ? recategorize(db) : 0 };
      });
    },
    'POST /api/transactions/confirm': b => withUndo(b.ids || [], () => ({ confirmed: confirmSuggestions(db, b.ids || []), similar: recategorize(db) })),
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
      const r = importTransactions(db, parsed.transactions.map(t => t.tx));
      return { ...r, skipped: r.skipped + parsed.duplicateRows.length, duplicatesInFile: parsed.duplicateRows.length,
        rowsInFile: parsed.rowsInFile, problems: parsed.skippedRows.slice(0, 20), problemCount: parsed.skippedRows.length,
        warnings: parsed.detection.warnings.slice(0, 10), encoding: parsed.detection.encoding, separator: parsed.detection.separator };
    },
    'POST /api/demo': () => {
      if (!ctx.demoCSV) throw httpErr(400, 'Geen voorbeelddata beschikbaar');
      return importTransactions(db, parseRabobankCsv(ctx.demoCSV()).transactions.map(t => t.tx));
    },

    'GET /api/rules': () => q(`SELECT r.*, c.name category, c.icon, (SELECT 1) x FROM rules r JOIN categories c ON c.id=r.category_id ORDER BY r.priority DESC, c.name, r.pattern`)
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

    'GET /api/memory': () => q(`SELECT m.key, m.n, m.label, m.category_id, c.name category, c.icon FROM memory m JOIN categories c ON c.id=m.category_id ORDER BY m.n DESC, m.label LIMIT 500`),
    'DELETE /api/memory': (_, __, u) => { run('DELETE FROM memory WHERE key=?', u.searchParams.get('key') || ''); return { ok: true, changed: recategorize(db) }; },

    'GET /api/accounts': () => accounts(),
    'PUT /api/accounts/:id': (b, { id }) => { run('UPDATE accounts SET name=? WHERE id=?', String(b.name || '').trim() || 'Rekening', id); recategorize(db); return { ok: true }; },

    'GET /api/budget': (_, __, u) => {
      const m = u.searchParams.get('month');
      if (!monthRe.test(m || '')) throw httpErr(400, 'month=YYYY-MM vereist');
      return budgetRows(m);
    },
    'PUT /api/budget': b => {
      if (!monthRe.test(b.month || '') || !b.category_id) throw httpErr(400, 'month en category_id vereist');
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
    'GET /api/export': () => {
      const rows = q(`SELECT t.date, t.amount, t.payee, t.description, COALESCE(c.name,'') cat, t.account, t.counter_iban, t.notes FROM transactions t LEFT JOIN categories c ON c.id=t.category_id ORDER BY t.date, t.id`);
      const qt = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      return { csv: ['Datum;Bedrag;Tegenpartij;Omschrijving;Categorie;Rekening;Tegenrekening;Notities', ...rows.map(r =>
        [r.date, (r.amount / 100).toFixed(2).replace('.', ','), r.payee, r.description, r.cat, r.account, r.counter_iban, r.notes].map(qt).join(';'))].join('\n') };
    },
    'POST /api/reset': b => { if (b.confirm !== 'WISSEN') throw httpErr(400, 'Bevestiging ontbreekt'); resetAll(db); return { ok: true }; },
  };

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

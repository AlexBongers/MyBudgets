// Leesmodel: alle (zware) leesqueries voor dashboard, budget, rapporten, transactielijst en drill-down.
// Geen schrijfacties; service.js gebruikt dit voor de API-routes.
import { detectRecurring } from './recurring.js';
import { AUTO_THRESHOLD } from './categorizer.js';
import { MONTH_RE as monthRe, DATE_RE, httpErr, addMonths, daysIn, eurText as eur, today as todayStr, addDays, clampInt } from './util.js';

/** Transacties die de gebruiker nog moet beoordelen (geen of te onzekere categorie). */
export const REVIEW = `t.confirmed=0 AND (t.category_id IS NULL OR t.cat_conf < ${AUTO_THRESHOLD - 0.001})`;
export const GRP_ORDER = "CASE c.grp WHEN 'Inkomen' THEN 0 WHEN 'Wonen' THEN 1 WHEN 'Dagelijks' THEN 2 WHEN 'Vervoer' THEN 3 WHEN 'Zorg & verzekeringen' THEN 4 WHEN 'Vrije tijd' THEN 5 WHEN 'Overig' THEN 6 WHEN 'Overboekingen' THEN 8 ELSE 7 END";
// Uitgave/inkomen: op soort van de categorie; zonder categorie op teken. Overboekingen tellen nergens mee.
const EXPENSE = "(c.kind='expense' OR (c.id IS NULL AND t.amount<0))";
const INCOME = "(c.kind='income' OR (c.id IS NULL AND t.amount>0))";
// Wat niet als 'vaste last' telt, ook al komt het regelmatig terug
const NOT_RECURRING_KEYS = ['groceries', 'dining', 'drugstore', 'fuel', 'shopping', 'cash', 'transit', 'leisure'];

export function createReports(db) {
  // MYB_PROFILE=1 toont trage queries (>5 ms) in de console
  const timed = (fn) => process.env.MYB_PROFILE ? (sql, ...p) => { const t = performance.now(); const r = fn(sql, ...p); const ms = performance.now() - t; if (ms > 5) console.log(`  [${ms.toFixed(0)} ms] ${sql.replace(/\s+/g, ' ').slice(0, 110)}`); return r; } : fn;
  const q = timed((sql, ...p) => db.prepare(sql).all(...p));
  const one = timed((sql, ...p) => db.prepare(sql).get(...p));
  const latestMonth = () => one('SELECT MAX(ym) m FROM transactions').m || new Date().toISOString().slice(0, 7);
  // Inkomsten/uitgaven per maand voor een reeks maanden in één query (datumbereik gebruikt de index)
  function totalsByMonth(list) {
    const rows = q(`SELECT t.ym mo,
      COALESCE(SUM(CASE WHEN ${INCOME} THEN t.amount END),0) AS income,
      COALESCE(-SUM(CASE WHEN ${EXPENSE} THEN t.amount END),0) AS expenses
      FROM tl t LEFT JOIN categories c ON c.id=t.category_id WHERE t.date >= ? AND t.date <= ? GROUP BY mo`, list[0] + '-01', list[list.length - 1] + '-31');
    const by = Object.fromEntries(rows.map(r => [r.mo, r]));
    return list.map(mo => ({ month: mo, income: by[mo]?.income ?? 0, expenses: by[mo]?.expenses ?? 0 }));
  }
  const monthTotals = m => { const { income, expenses } = totalsByMonth([m])[0]; return { income, expenses }; };
  function spentByCat(m) {
    return Object.fromEntries(q(`SELECT category_id c, -SUM(amount) s FROM tl WHERE ym=? AND category_id IS NOT NULL GROUP BY category_id`, m).map(r => [r.c, r.s]));
  }
  function budgetRows(m) {
    const spent = spentByCat(m);
    const avg = Object.fromEntries(q(`SELECT category_id c, -SUM(amount)/3.0 a FROM tl WHERE ym IN (?,?,?) AND category_id IS NOT NULL GROUP BY category_id`,
      addMonths(m, -1), addMonths(m, -2), addMonths(m, -3)).map(r => [r.c, Math.round(r.a)]));
    const carry = rolloverCarry(m);
    return q(`SELECT c.id, c.name, c.color, c.icon, c.grp, c.rollover,
        (SELECT amount FROM budgets b WHERE b.category_id=c.id AND b.month<=? ORDER BY month DESC LIMIT 1) AS budget,
        EXISTS(SELECT 1 FROM budgets b WHERE b.category_id=c.id AND b.month=?) AS explicit
      FROM categories c WHERE c.kind='expense' ORDER BY ${GRP_ORDER}, c.grp, c.name`, m, m)
      .map(r => {
        const budget = r.budget ?? 0, c = carry[r.id] ?? 0;
        // limit = wat deze maand beschikbaar is (budget + overgedragen saldo van eerdere maanden)
        return { ...r, rollover: !!r.rollover, budget, carry: c, limit: budget + c, explicit: !!r.explicit, spent: spent[r.id] ?? 0, avg3: Math.max(0, avg[r.id] ?? 0) };
      });
  }
  // Overdracht (envelope): per categorie met rollover de som van (budget − besteed) over alle eerdere maanden sinds het eerste budget.
  function rolloverCarry(m) {
    const ids = q('SELECT id FROM categories WHERE kind=\'expense\' AND rollover=1').map(r => r.id);
    const out = {}; if (!ids.length) return out;
    const ph = ids.map(() => '?').join(',');
    const budgets = q(`SELECT category_id c, month, amount FROM budgets WHERE category_id IN (${ph}) AND month<? ORDER BY month`, ...ids, m);
    const spent = q(`SELECT category_id c, ym, -SUM(amount) s FROM tl WHERE category_id IN (${ph}) AND ym<? GROUP BY category_id, ym`, ...ids, m);
    const sp = new Map(spent.map(r => [r.c + '|' + r.ym, r.s]));
    const firstTx = one('SELECT MIN(ym) m FROM transactions').m; // een budget 'vanaf het begin' telt pas vanaf de eerste transactie
    for (const id of ids) {
      const bs = budgets.filter(b => b.c === id); if (!bs.length) continue;
      let k = bs[0].month, bi = 0, cur = 0, total = 0, guardN = 0;
      if (firstTx && k < firstTx) k = firstTx;
      while (k < m && guardN++ < 120) {
        while (bi < bs.length && bs[bi].month <= k) cur = bs[bi++].amount;
        total += cur - (sp.get(id + '|' + k) ?? 0);
        k = addMonths(k, 1);
      }
      out[id] = total;
    }
    return out;
  }
  function accounts() {
    return q('SELECT * FROM accounts ORDER BY id').map(a => {
      const last = one('SELECT balance, date FROM transactions WHERE account_id=? AND balance IS NOT NULL ORDER BY date DESC, seq DESC, id DESC LIMIT 1', a.id);
      const n = one('SELECT COUNT(*) c, MIN(date) f, MAX(date) t FROM transactions WHERE account_id=?', a.id);
      return { ...a, balance: last?.balance ?? null, balance_date: last?.date ?? null, count: n.c, from: n.f, to: n.t };
    });
  }
  // Totaalsaldo over de tijd: per rekening het laatste "saldo na transactie" per dag, vooruit gedragen en opgeteld.
  function balanceHistory(months) {
    const accs = q('SELECT id FROM accounts');
    const latest = one('SELECT MAX(date) d FROM transactions').d; if (!latest) return [];
    const startMonth = addMonths(latest.slice(0, 7), -(months - 1)), from = startMonth + '-01';
    const perDay = new Map(); // date -> Map(account -> balance)
    const initial = new Map();
    for (const a of accs) {
      const before = one('SELECT balance FROM transactions WHERE account_id=? AND balance IS NOT NULL AND date<? ORDER BY date DESC, seq DESC, id DESC LIMIT 1', a.id, from);
      if (before) initial.set(a.id, before.balance);
      for (const r of q('SELECT date, balance FROM transactions WHERE account_id=? AND balance IS NOT NULL AND date>=? ORDER BY date, seq, id', a.id, from)) {
        if (!perDay.has(r.date)) perDay.set(r.date, new Map());
        perDay.get(r.date).set(a.id, r.balance);
      }
    }
    const cur = new Map(initial), pts = [];
    for (const d of [...perDay.keys()].sort()) {
      for (const [k, v] of perDay.get(d)) cur.set(k, v);
      pts.push({ date: d, balance: [...cur.values()].reduce((x, y) => x + y, 0) });
    }
    return pts;
  }
  // Cache: het resultaat verandert alleen als er iets in de database is geschreven (total_changes telt alle wijzigingen)
  let recCache = { v: -1, data: [] };
  function recurring() {
    const v = one('SELECT total_changes() v').v;
    if (recCache.v === v) return recCache.data;
    const data = computeRecurring(); recCache = { v, data }; return data;
  }
  function computeRecurring() {
    const rows = q(`SELECT t.merchant, t.payee, t.date, t.amount, t.category_id FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
      WHERE t.amount<0 AND (c.id IS NULL OR (c.kind='expense' AND COALESCE(c.key,'') NOT IN (${NOT_RECURRING_KEYS.map(k => `'${k}'`).join(',')}))) AND t.merchant<>'' AND t.date >= date((SELECT MAX(date) FROM transactions), '-18 months')`);
    const latest = one('SELECT MAX(date) d FROM transactions').d;
    const ignored = new Set(q('SELECT merchant FROM ignored_recurring').map(r => r.merchant));
    return latest ? detectRecurring(rows.filter(r => !ignored.has(r.merchant)), latest) : [];
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
      if (b.budget > 0 && b.spent > b.limit) out.push({ type: 'warn', text: `${b.icon} ${b.name} staat ${eur(b.spent - b.limit)} boven budget.` });
      else if (b.budget > 0 && b.limit > 0 && b.spent > b.limit * 0.85) out.push({ type: 'info', text: `${b.icon} ${b.name}: ${Math.round(b.spent / b.limit * 100)}% van het budget is besteed.` });
    }
    if (d.projection) {
      const tb = d.budget.reduce((a, b) => a + b.budget, 0);
      out.push({ type: tb && d.projection.expenses > tb ? 'warn' : 'info', text: `Op dit tempo kom je uit op ${eur(d.projection.expenses)} aan uitgaven${tb ? ` (budget ${eur(tb)})` : ''}.` });
    }
    const big = one(`SELECT t.payee, -t.amount a FROM tl t LEFT JOIN categories c ON c.id=t.category_id WHERE t.ym=? AND ${EXPENSE} ORDER BY t.amount LIMIT 1`, m);
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
      FROM tl t LEFT JOIN categories c ON c.id=t.category_id WHERE t.ym=? AND ${EXPENSE} GROUP BY c.id HAVING value > 0 ORDER BY value DESC`, m)
      .map(c => ({ ...c, prev: prevSpent[c.id] ?? 0 }));
    const trend = totalsByMonth(Array.from({ length: 12 }, (_, i) => addMonths(m, i - 11)));
    const topPayees = q(`SELECT MAX(t.payee) payee, t.merchant, MAX(COALESCE(c.icon,'❔')) icon, -SUM(t.amount) value, COUNT(*) n
      FROM tl t LEFT JOIN categories c ON c.id=t.category_id WHERE t.ym=? AND ${EXPENSE} GROUP BY t.merchant HAVING value > 0 ORDER BY value DESC LIMIT 8`, m);
    const budget = budgetRows(m).filter(b => b.budget > 0 || b.spent > 0);
    // cumulatieve uitgaven per dag (deze + vorige maand)
    const cum = mm => {
      const n = daysIn(mm), per = Array(n + 1).fill(0);
      q(`SELECT CAST(substr(t.date,9,2) AS INTEGER) d, -SUM(t.amount) v FROM tl t LEFT JOIN categories c ON c.id=t.category_id
        WHERE t.ym=? AND ${EXPENSE} GROUP BY d`, mm).forEach(r => { per[r.d] = r.v; });
      let s = 0; return per.slice(1).map(v => (s += v));
    };
    const today = todayStr();
    const isCurrent = today.slice(0, 7) === m, dim = daysIn(m);
    const cumul = { month: cum(m), prev: cum(prevMonth), days: dim };
    if (isCurrent) cumul.month = cumul.month.slice(0, +today.slice(8, 10));
    const rec = recurring().filter(r => r.active);
    let projection = null;
    if (isCurrent && totals.expenses > 0) {
      // vaste lasten: wat al betaald is + wat nog verwacht wordt; variabel: huidig tempo
      const dom = +today.slice(8, 10), mset = new Set(rec.map(r => r.merchant));
      const paid = q(`SELECT t.merchant, -SUM(t.amount) v FROM tl t WHERE t.ym=? AND t.amount<0 GROUP BY t.merchant`, m)
        .filter(r => mset.has(r.merchant));
      const paidSet = new Set(paid.map(r => r.merchant)), paidSum = paid.reduce((a, r) => a + r.v, 0);
      const remaining = rec.filter(r => !paidSet.has(r.merchant) && r.next.slice(0, 7) === m && r.next > today).reduce((a, r) => a + r.amount, 0);
      projection = { expenses: Math.round(paidSum + remaining + (totals.expenses - paidSum) / dom * dim) };
    }
    const recurringMonthly = rec.reduce((a, r) => a + r.monthly, 0);
    const horizon = addDays(today, 30);
    const upcoming = rec.filter(r => r.next >= today && r.next <= horizon).sort((a, b) => a.next.localeCompare(b.next))
      .map(r => ({ name: r.name, merchant: r.merchant, next: r.next, amount: r.amount, variable: r.variable, category_id: r.category_id }));
    const d = {
      upcoming, balanceHistory: balanceHistory(12),
      month: m, totals, prevTotals, byCategory, trend, topPayees, budget, cumul, projection, recurringMonthly,
      review: one(`SELECT COUNT(*) c FROM transactions t WHERE ${REVIEW}`).c,
      months: q('SELECT DISTINCT ym m FROM transactions ORDER BY m DESC').map(r => r.m),
      accounts: accounts(), txCount: one('SELECT COUNT(*) c FROM transactions').c,
    };
    d.insights = insights(m, d);
    return d;
  }

  function listTransactions(u) {
    const p = u.searchParams, where = [], args = [];
    const month = p.get('month');
    if (month && monthRe.test(month)) { where.push('t.ym=?'); args.push(month); }
    if (p.get('status') === 'review') where.push(REVIEW);
    if (p.get('status') === 'uncategorized') where.push('t.category_id IS NULL');
    if (p.get('category') === 'none') where.push('t.category_id IS NULL');
    else if (p.get('category')) { where.push('(t.category_id=? OR EXISTS (SELECT 1 FROM splits s WHERE s.tx_id=t.id AND s.category_id=?))'); args.push(Number(p.get('category')), Number(p.get('category'))); }
    if (p.get('account')) { where.push('t.account_id=?'); args.push(Number(p.get('account'))); }
    if (p.get('merchant')) { where.push('t.merchant=?'); args.push(p.get('merchant')); }
    if (DATE_RE.test(p.get('from') || '')) { where.push('t.date>=?'); args.push(p.get('from')); }
    if (DATE_RE.test(p.get('to') || '')) { where.push('t.date<=?'); args.push(p.get('to')); }
    if (p.get('type') === 'in') where.push('t.amount>0'); if (p.get('type') === 'out') where.push('t.amount<0');
    if (p.get('q')) { const like = `%${p.get('q')}%`; where.push('(t.payee LIKE ? OR t.description LIKE ? OR t.notes LIKE ? OR t.counter_iban LIKE ?)'); args.push(like, like, like, like); }
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sort = { date: 't.date', amount: 't.amount', payee: 't.payee COLLATE NOCASE' }[p.get('sort')] || 't.date';
    const dir = p.get('dir') === 'asc' ? 'ASC' : 'DESC';
    // geklemd: een negatieve LIMIT betekent in SQLite "geen limiet", een kommagetal geeft een SQL-fout
    const limit = clampInt(p.get('limit'), 1, 2000, 300), offset = clampInt(p.get('offset'), 0, 1e9, 0);
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
    const cells = q(`SELECT c.id, c.kind, t.ym mo, SUM(t.amount) v FROM tl t JOIN categories c ON c.id=t.category_id
      WHERE t.date>=? AND t.date<=? AND c.kind<>'transfer' GROUP BY c.id, mo`, from, to);
    const cats = q(`SELECT c.id, c.name, c.kind, c.color, c.icon, c.grp FROM categories c WHERE c.kind<>'transfer' ORDER BY c.kind DESC, ${GRP_ORDER}, c.grp, c.name`);
    const map = {}; cells.forEach(r => { (map[r.id] ||= {})[r.mo] = r.kind === 'income' ? r.v : -r.v; });
    const unc = q(`SELECT ym mo, SUM(amount) v FROM tl WHERE category_id IS NULL AND date>=? AND date<=? GROUP BY mo`, from, to);
    // inkomen: positieve bedragen; uitgaven: positief = uitgave (terugbetalingen verlagen)
    const rows = cats.map(c => ({ ...c, values: list.map(mo => map[c.id]?.[mo] ?? 0) })).filter(r => r.values.some(v => v !== 0));
    return { months: list, rows, uncategorized: list.map(mo => -(unc.find(u => u.mo === mo)?.v ?? 0)), totals: totalsByMonth(list).map(({ income, expenses }) => ({ income, expenses })) };
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
    const rows = q(`SELECT t.ym mo, SUM(t.amount) v, COUNT(*) n FROM tl t WHERE ${where} AND t.date>=? AND t.date<=? GROUP BY mo`, ...args, from, to);
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


  return { q, one, latestMonth, totalsByMonth, monthTotals, spentByCat, budgetRows, accounts, balanceHistory, recurring, insights, dashboard, listTransactions, review, report, detail };
}

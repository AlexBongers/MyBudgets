// De categoriseermodule. Pure logica (geen database), zodat hij goed testbaar is.
//
// Lagen, van sterk naar zwak - de eerste die iets vindt wint:
//   1. rule     Eigen regels (veld/operator/bedrag/richting/prioriteit)
//   2. own      Tegenrekening is een eigen rekening -> overboeking
//   3. memory   Eerdere handmatige keuzes voor dezelfde winkel/IBAN
//   4. builtin  Ingebouwd woordenboek van Nederlandse winkels en instanties
//   5. heur     Rabobank-transactiecode (bijv. geldautomaat)
//   6. ml       Naive-Bayes-suggestie getraind op jouw eigen bevestigde transacties
//
// Elk resultaat heeft een zekerheid (0..1) en een uitleg. Onder AUTO_THRESHOLD blijft een
// transactie "te beoordelen"; de gebruiker bevestigt of corrigeert, en het systeem leert.
import { clean, fold, merchantKey, tokensOf } from './normalize.js';
import { MERCHANTS } from './merchants.js';

export const AUTO_THRESHOLD = 0.8;
const normIban = s => String(s || '').replace(/\s+/g, '').toUpperCase();
const NO_IBAN_MEMORY = new Set(['id', 'ba', 'bc', 'ga', 'cc']); // iDEAL/pin: IBAN zegt niets over de winkel

export function prepare(tx) {
  return { ...tx, merchant: tx.merchant || merchantKey(tx.payee, tx.description) };
}

export class Categorizer {
  constructor({ categories, rules = [], memory = [], ownIbans = [], training = [], recurringIncome = [] }) {
    this.recurringIncome = new Set(recurringIncome);
    this.byId = new Map(categories.map(c => [c.id, c]));
    this.byKey = new Map(categories.filter(c => c.key).map(c => [c.key, c]));
    this.rules = rules.filter(r => r.enabled !== 0 && this.byId.has(r.category_id))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(b.pattern).length - String(a.pattern).length);
    this.reCache = new Map();
    this.memory = new Map();
    for (const m of memory) {
      if (!this.byId.has(m.category_id)) continue;
      if (!this.memory.has(m.key)) this.memory.set(m.key, []);
      this.memory.get(m.key).push({ category_id: m.category_id, n: m.n });
    }
    this.own = new Set(ownIbans.map(normIban).filter(Boolean));
    this.builtin = []; this.bIndex = new Map(); this.bMaxN = 1;
    for (const [key, conf, pats] of MERCHANTS) {
      const cat = this.byKey.get(key);
      if (!cat) continue; // categorie verwijderd door gebruiker
      for (const p of pats) {
        const cp = clean(p); if (!cp) continue;
        const e = { len: cp.length, cat, conf, raw: cp, ord: this.builtin.length };
        this.builtin.push(e);
        if (!this.bIndex.has(cp)) this.bIndex.set(cp, []);
        this.bIndex.get(cp).push(e);
        this.bMaxN = Math.max(this.bMaxN, cp.split(' ').length);
      }
    }
    this.nb = trainNB(training.filter(t => this.byId.has(t.category_id)));
  }

  classify(rawTx) {
    const tx = prepare(rawTx);
    return this.byRule(tx) || this.byOwnAccount(tx) || this.byMemory(tx) || this.byBuiltin(tx)
      || this.byHeuristic(tx) || this.byML(tx) || null;
  }

  // ---- 1. regels
  matchRule(r, tx) {
    const amt = Math.abs(tx.amount);
    if (r.direction === 'in' && !(tx.amount > 0)) return false;
    if (r.direction === 'out' && !(tx.amount < 0)) return false;
    if (r.amount_min != null && amt < r.amount_min) return false;
    if (r.amount_max != null && amt > r.amount_max) return false;
    const field = r.field || 'any';
    const text = field === 'payee' ? tx.payee : field === 'description' ? tx.description
      : field === 'iban' ? tx.counter_iban : `${tx.payee} ${tx.description} ${tx.counter_iban || ''}`;
    const hay = fold(text), pat = fold(r.pattern);
    if (!pat && r.op !== 'regex') return true; // alleen bedrag/richting als voorwaarde
    switch (r.op || 'contains') {
      case 'equals': return field === 'iban' ? normIban(text) === normIban(r.pattern) : hay.trim() === pat.trim();
      case 'startswith': return hay.trim().startsWith(pat);
      case 'regex': {
        let re = this.reCache.get(r.pattern);
        if (re === undefined) { try { re = new RegExp(r.pattern, 'i'); } catch { re = null; } this.reCache.set(r.pattern, re); }
        return !!re && re.test(String(text || ''));
      }
      default: return field === 'iban' ? normIban(text).includes(normIban(r.pattern)) : hay.includes(pat);
    }
  }
  byRule(tx) {
    for (const r of this.rules) if (this.matchRule(r, tx))
      return { category_id: r.category_id, source: 'rule', confidence: 1, reason: `Regel: ${describeRule(r)}`, rule_id: r.id };
    return null;
  }

  // ---- 2. eigen rekeningen
  byOwnAccount(tx) {
    if (!tx.counter_iban || !this.own.has(normIban(tx.counter_iban))) return null;
    const cat = this.byKey.get('transfer') || [...this.byId.values()].find(c => c.kind === 'transfer');
    return cat ? { category_id: cat.id, source: 'own', confidence: 0.95, reason: 'Overboeking naar eigen rekening' } : null;
  }

  // ---- 3. geheugen
  byMemory(tx) {
    const keys = [];
    if (tx.counter_iban && !NO_IBAN_MEMORY.has(String(tx.code || '').toLowerCase())) keys.push('i:' + normIban(tx.counter_iban));
    if (tx.merchant) keys.push('m:' + tx.merchant);
    for (const k of keys) {
      const arr = this.memory.get(k);
      if (!arr?.length) continue;
      const total = arr.reduce((a, b) => a + b.n, 0);
      const best = arr.reduce((a, b) => (b.n > a.n ? b : a));
      const conf = Math.min(0.99, (best.n / total) * (total / (total + 0.25)));
      return { category_id: best.category_id, source: 'memory', confidence: conf,
        reason: `Eerder zo ingedeeld (${best.n}×)${best.n < total ? `, soms anders` : ''}` };
    }
    return null;
  }

  // ---- 4. woordenboek
  byBuiltin(tx) {
    // n-gram-index: elke aaneengesloten woordreeks van de tekst opzoeken (zelfde semantiek als matchen op woordgrenzen)
    const w = clean(`${tx.payee} ${tx.description}`).split(' ').filter(Boolean);
    let best = null;
    for (let n = 1; n <= Math.min(this.bMaxN, w.length); n++) {
      for (let i = 0; i + n <= w.length; i++) {
        const hits = this.bIndex.get(n === 1 ? w[i] : w.slice(i, i + n).join(' '));
        if (!hits) continue;
        for (const b of hits) {
          if (b.cat.kind === 'income' && !(tx.amount > 0)) continue;       // inkomen kan geen uitgave zijn
          if (!best || b.len > best.len || (b.len === best.len && (b.conf > best.conf || (b.conf === best.conf && b.ord < best.ord)))) best = b;
        }
      }
    }
    if (!best) return null;
    // Een inkomende betaling bij een uitgavecategorie is meestal een terugbetaling: minder zeker.
    const refund = best.cat.kind === 'expense' && tx.amount > 0;
    return { category_id: best.cat.id, source: 'builtin', confidence: refund ? Math.min(best.conf, 0.7) : best.conf,
      reason: refund ? `Mogelijk terugbetaling: "${best.raw}"` : `Bekende tegenpartij: "${best.raw}"` };
  }

  // ---- 5. heuristieken op Rabobank-code
  byHeuristic(tx) {
    if (String(tx.code || '').toLowerCase() === 'ga') {
      const cat = this.byKey.get('cash');
      if (cat) return { category_id: cat.id, source: 'heur', confidence: 0.9, reason: 'Geldopname bij geldautomaat' };
    }
    // Maandelijks terugkerend, vergelijkbaar inkomend bedrag van dezelfde partij: waarschijnlijk salaris (alleen suggestie)
    if (tx.amount > 0 && tx.merchant && this.recurringIncome.has(tx.merchant)) {
      const cat = this.byKey.get('salary');
      if (cat) return { category_id: cat.id, source: 'heur', confidence: 0.75, reason: 'Terugkerend maandelijks inkomen: waarschijnlijk salaris' };
    }
    return null;
  }

  // ---- 6. leermodel
  byML(tx) {
    const r = predictNB(this.nb, tokensOf(tx));
    if (!r) return null;
    const cat = this.byId.get(r.category_id);
    if (cat.kind === 'income' && !(tx.amount > 0)) return null;
    return { category_id: r.category_id, source: 'ml', confidence: Math.min(0.7, r.p * 0.7),
      reason: `Lijkt op eerdere transacties (${Math.round(r.p * 100)}% zeker)` };
  }
}

export function describeRule(r) {
  const f = { any: 'alles', payee: 'tegenpartij', description: 'omschrijving', iban: 'IBAN' }[r.field || 'any'];
  const o = { contains: 'bevat', equals: 'is', startswith: 'begint met', regex: 'regex' }[r.op || 'contains'];
  const parts = [];
  if (r.pattern) parts.push(`${f} ${o} "${r.pattern}"`);
  if (r.direction === 'in') parts.push('inkomend'); if (r.direction === 'out') parts.push('uitgaand');
  if (r.amount_min != null) parts.push(`≥ €${(r.amount_min / 100).toFixed(2)}`);
  if (r.amount_max != null) parts.push(`≤ €${(r.amount_max / 100).toFixed(2)}`);
  return parts.join(', ') || '(leeg)';
}

// ---------- Naive Bayes (multinomial, Laplace-smoothing) ----------
function trainNB(rows) {
  const cats = new Map(); const vocab = new Set(); let n = 0;
  for (const r of rows) {
    const toks = r.tokens || tokensOf(r);
    let c = cats.get(r.category_id);
    if (!c) cats.set(r.category_id, c = { docs: 0, words: new Map(), total: 0 });
    c.docs++; n++;
    for (const t of toks) { c.words.set(t, (c.words.get(t) || 0) + 1); c.total++; vocab.add(t); }
  }
  return { cats, vocab, n };
}
function predictNB(nb, toks) {
  if (nb.n < 15 || nb.cats.size < 2) return null;
  const known = toks.filter(t => nb.vocab.has(t) && !t.startsWith('__'));
  if (!known.length) return null;
  const V = nb.vocab.size, scores = [];
  for (const [id, c] of nb.cats) {
    let s = Math.log(c.docs / nb.n);
    for (const t of toks) s += Math.log(((c.words.get(t) || 0) + 0.5) / (c.total + 0.5 * V));
    scores.push([id, s]);
  }
  const mx = Math.max(...scores.map(s => s[1]));
  const exp = scores.map(([id, s]) => [id, Math.exp(s - mx)]);
  const sum = exp.reduce((a, b) => a + b[1], 0);
  const [id, e] = exp.reduce((a, b) => (b[1] > a[1] ? b : a));
  const p = e / sum;
  return p >= 0.55 ? { category_id: id, p } : null;
}

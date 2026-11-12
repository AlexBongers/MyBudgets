// Importer voor een Notion-export: een ZIP ("Markdown & CSV") of losse CSV-bestanden.
//
// Notion heeft geen vast budget-formaat; iedereen bouwt zijn eigen database. Daarom werkt deze importer
// niet van een vaste kolomindeling uit, maar:
//   1. leest alle tabellen uit de export (ook geneste ZIP's, `_all.csv`-varianten, BOM, puntkomma),
//   2. raadt per tabel het soort (transacties / budgetten) en de kolommen (op naam én op waarden),
//   3. ontleedt datums en bedragen soepel (NL en EN notatie, bereiken, valuta, relaties),
//   4. maakt een PLAN (voorbeeld zonder te schrijven) en voert dat daarna uit.
// Bestaande transacties (bijv. uit je Rabobank-import) worden verrijkt met de Notion-categorie in plaats van dubbel te worden.
import { createHash } from 'node:crypto';
import { isZip, readZip } from './zip.js';
import { parseCsvRows, detectSeparator } from './rabobank.js';
import { fold, merchantKey, displayName, tidyDescription } from './normalize.js';
import { withTx, applyManual, recategorize } from './db.js';

// ---------------------------------------------------------------- tabellen lezen
const stripNotionId = n => n.replace(/_all$/i, '').replace(/\s+[0-9a-f]{32}$/i, '').replace(/\s+[0-9a-f]{32}(?=\.)/i, '');
const decodeText = buf => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
};

export function csvToTable(text, name) {
  text = text.replace(/^﻿/, '');
  if (!text.trim()) return null;
  let sep = ','; try { sep = detectSeparator(text); } catch { /* één kolom: geen scheidingsteken */ }
  const rows = parseCsvRows(text, sep).rows.map(r => r.fields).filter(r => r.some(c => c.trim()));
  if (rows.length < 2) return null;
  const headers = rows[0].map((h, i) => h.replace(/^﻿/, '').trim() || `Kolom ${i + 1}`);
  const data = rows.slice(1).map(r => headers.map((_, i) => (r[i] ?? '').trim()));
  return { name, headers, rows: data };
}

/** @returns {{name: string, headers: string[], rows: string[][]}[]} */
export function loadTables(input, fileName = '', depth = 0) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!isZip(buf)) {
    const t = csvToTable(decodeText(buf), stripNotionId(String(fileName).replace(/\.[^.]+$/, '')) || 'Tabel');
    if (!t) throw new Error('Geen tabel gevonden: het bestand is leeg of heeft geen gegevensregels.');
    return [t];
  }
  const found = new Map(); // naam -> tabel (de `_all`-variant of grootste wint)
  for (const e of readZip(buf)) {
    if (/\.zip$/i.test(e.name) && depth < 2) { for (const t of loadTables(e.data, e.name, depth + 1)) keep(found, t); continue; }
    if (!/\.csv$/i.test(e.name)) continue;
    const base = stripNotionId(e.name.split('/').pop().replace(/\.csv$/i, ''));
    const t = csvToTable(decodeText(e.data), base);
    if (t) keep(found, t);
  }
  if (!found.size) throw new Error('In dit ZIP-bestand zitten geen CSV-tabellen. Exporteer uit Notion als "Markdown & CSV".');
  return [...found.values()];
}
const keep = (map, t) => { const o = map.get(t.name); if (!o || t.rows.length > o.rows.length) map.set(t.name, t); };

// ---------------------------------------------------------------- waarden ontleden
const MONTHS = { januari: 1, january: 1, jan: 1, februari: 2, february: 2, feb: 2, maart: 3, march: 3, mrt: 3, mar: 3, april: 4, apr: 4, mei: 5, may: 5,
  juni: 6, june: 6, jun: 6, juli: 7, july: 7, jul: 7, augustus: 8, august: 8, aug: 8, september: 9, sept: 9, sep: 9, oktober: 10, october: 10, okt: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12 };
const iso = (y, m, d) => {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};

/** Ontleedt een Notion-datum. order: 'dmy' | 'mdy' voor dubbelzinnige 03/04/2026. Bereiken ("a → b") nemen de start. */
export function parseLooseDate(value, order = 'dmy') {
  let s = String(value ?? '').trim().replace(/^@/, '');
  if (!s) return null;
  s = s.split(/\s*(?:→|->|—|–)\s*/)[0].trim();
  s = s.replace(/^(maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/i, '');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (m) return order === 'mdy' ? iso(+m[3], +m[1], +m[2]) : iso(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-zà-ÿ]+)\.?,?\s+(\d{4})/i.exec(s);
  if (m && MONTHS[fold(m[2])]) return iso(+m[3], MONTHS[fold(m[2])], +m[1]);
  m = /^([a-zà-ÿ]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(s);
  if (m && MONTHS[fold(m[1])]) return iso(+m[3], MONTHS[fold(m[1])], +m[2]);
  return null;
}
/** Kijkt in de hele kolom of 03/04/2026 als dag/maand of maand/dag bedoeld is. */
export function detectDateOrder(values) {
  let dmy = 0, mdy = 0;
  for (const v of values) { const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(String(v).trim()); if (m) { if (+m[1] > 12) dmy++; if (+m[2] > 12) mdy++; } }
  return mdy > dmy ? 'mdy' : 'dmy';
}

/** Welk teken is de decimaalscheiding in deze kolom? ',' (NL) of '.' (EN). */
export function detectDecimalSep(values) {
  let comma = 0, dot = 0;
  for (const v of values) {
    const s = String(v).replace(/[^\d.,]/g, '');
    const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    if (lc > ld && /^\d{1,2}$/.test(s.slice(lc + 1))) comma++;
    else if (ld > lc && /^\d{1,2}$/.test(s.slice(ld + 1))) dot++;
    else if (lc >= 0 && ld >= 0) { if (lc > ld) comma++; else dot++; }
  }
  return dot > comma ? '.' : ',';
}

/** Bedrag in centen of null. Kent €, EUR, −, haakjes, achterliggende min, spaties en beide decimaalnotaties. */
export function parseLooseMoney(value, dec = ',') {
  let s = String(value ?? '').trim();
  if (!s) return null;
  let neg = false;
  s = s.replace(/[−–—]/g, '-');
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[€$£]|EUR|euro/gi, '').replace(/[\s  ']/g, '');
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d[\d.,]*$/.test(s) && !/^[.,]\d+$/.test(s)) return null;
  const thousands = dec === ',' ? '.' : ',';
  // één scheidingsteken dat de ander-notatie zou zijn, met precies 3 cijfers erachter en meerdere keren: duizendtallen
  s = s.split(thousands).join('');
  if (dec === ',') s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  if ((s.match(/\./g) || []).length > 1) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return neg ? -cents : cents;
}

const cleanRelation = s => String(s ?? '').replace(/\s*\(https?:\/\/[^)]*\)/g, '').replace(/%20/g, ' ').trim();
const firstOf = s => cleanRelation(s).split(/\s*[,;]\s*(?![^()]*\))/)[0].trim();

// ---------------------------------------------------------------- kolommen raden
const ALIAS = {
  date: ['datum', 'date', 'boekdatum', 'transactiedatum', 'dag', 'wanneer', 'when', 'tijdstip', 'betaaldatum', 'valutadatum', 'created', 'aangemaakt'],
  amount: ['bedrag', 'bedrageur', 'bedrag€', 'amount', 'waarde', 'prijs', 'price', 'kosten', 'cost', 'totaal', 'total', 'euro', 'eur', 'mutatie', 'saldo'],
  amountOut: ['uitgave', 'uitgaven', 'af', 'debet', 'debit', 'expense', 'expenses', 'betaald', 'uit'],
  amountIn: ['inkomsten', 'inkomen', 'bij', 'credit', 'income', 'ontvangen', 'in'],
  type: ['type', 'soort', 'afbij', 'richting', 'transactietype', 'direction', 'kind'],
  payee: ['naam', 'name', 'tegenpartij', 'titel', 'title', 'winkel', 'merchant', 'payee', 'begunstigde', 'omschrijving', 'beschrijving', 'description', 'item', 'wat', 'bij wie'],
  description: ['omschrijving', 'beschrijving', 'description', 'details', 'detail', 'mededelingen', 'mededeling', 'memo', 'toelichting', 'opmerking', 'opmerkingen'],
  notes: ['notitie', 'notities', 'notes', 'note', 'opmerking', 'opmerkingen'],
  category: ['categorie', 'category', 'cat', 'categorieen', 'categories', 'groep', 'group', 'tag', 'tags', 'label', 'budgetcategorie', 'soortuitgave'],
  account: ['rekening', 'account', 'bank', 'iban', 'rekeningnummer', 'bankrekening', 'pot', 'portemonnee', 'wallet'],
  month: ['maand', 'month', 'periode', 'period', 'vanaf', 'from'],
  budget: ['budget', 'begroot', 'begroting', 'limiet', 'limit', 'maandbudget', 'gepland', 'planned', 'target', 'doel'],
};
const norm = h => fold(h).replace(/[^a-z0-9€]/g, '');
const colStats = (table, i) => {
  const vals = table.rows.map(r => r[i]).filter(Boolean).slice(0, 400);
  const dateOrder = detectDateOrder(vals), dec = detectDecimalSep(vals);
  const n = Math.max(1, vals.length);
  return {
    n: vals.length, vals,
    date: vals.filter(v => parseLooseDate(v, dateOrder)).length / n,
    num: vals.filter(v => parseLooseMoney(v, dec) !== null).length / n,
    unique: new Set(vals).size, uniqueRatio: new Set(vals).size / n,
    iban: vals.filter(v => /^[A-Z]{2}\d{2}\s?[A-Z0-9]{4}/i.test(v.replace(/\s+/g, ''))).length / n,
  };
};

/** Raad het soort tabel en de bijbehorende kolomtoewijzing. Geeft ook alle stats terug voor de UI. */
export function guessMapping(table) {
  const stats = table.headers.map((_, i) => colStats(table, i));
  const idx = h => table.headers.indexOf(h);
  const byAlias = (key, ok = () => true, taken = new Set()) => {
    for (const a of ALIAS[key]) for (let i = 0; i < table.headers.length; i++) if (!taken.has(i) && norm(table.headers[i]) === a && ok(stats[i])) return i;
    for (const a of ALIAS[key]) for (let i = 0; i < table.headers.length; i++) if (!taken.has(i) && a.length > 3 && norm(table.headers[i]).includes(a) && ok(stats[i])) return i;
    return -1;
  };
  const taken = new Set(); const pick = (i) => { if (i >= 0) taken.add(i); return i >= 0 ? table.headers[i] : null; };
  const f = {};
  let di = byAlias('date', s => s.date >= 0.6, taken);
  if (di < 0) { let best = -1, bs = 0.8; stats.forEach((s, i) => { if (s.date > bs && !taken.has(i)) { bs = s.date; best = i; } }); di = best; }
  f.date = pick(di);
  let ai = byAlias('amount', s => s.num >= 0.6, taken);
  const oi = byAlias('amountOut', s => s.num >= 0.4, taken), ii = byAlias('amountIn', s => s.num >= 0.4, taken);
  if (ai < 0 && oi >= 0 && ii >= 0 && oi !== ii) { f.amountOut = pick(oi); f.amountIn = pick(ii); }
  else {
    if (ai < 0) { let best = -1, bs = 0.8; stats.forEach((s, i) => { if (s.num > bs && s.date < 0.5 && !taken.has(i) && s.uniqueRatio > 0.15) { bs = s.num; best = i; } }); ai = best; }
    f.amount = pick(ai);
  }
  const ti = byAlias('type', s => s.unique >= 2 && s.unique <= 6, taken);
  if (ti >= 0 && stats[ti].vals.some(v => /uitgave|inkomst|expense|income|af$|bij$|debit|credit|kosten|^uit$|^in$/i.test(v))) f.type = pick(ti);
  const ci = byAlias('category', s => s.unique >= 1 && s.unique <= 120 && s.num < 0.5 && s.date < 0.5, taken);
  f.category = pick(ci);
  const acc = byAlias('account', s => s.unique <= 30 && s.num < 0.5, taken); f.account = pick(acc);
  let pi = byAlias('payee', s => s.num < 0.8 && s.date < 0.5, taken);
  if (pi < 0) { pi = 0; while (pi < table.headers.length && (taken.has(pi) || stats[pi].num > 0.8 || stats[pi].date > 0.5)) pi++; if (pi >= table.headers.length) pi = -1; }
  f.payee = pick(pi);
  const de = byAlias('description', s => s.num < 0.8 && s.date < 0.5, taken); f.description = pick(de);
  const no = byAlias('notes', s => s.num < 0.8 && s.date < 0.5, taken); f.notes = pick(no);

  let kind = 'transactions';
  const hasBudget = table.headers.some(h => ALIAS.budget.some(a => norm(h).includes(a)));
  if (!f.date && (hasBudget || /budget|begroting/i.test(table.name)) && f.category) kind = 'budgets';
  else if (!f.date || !(f.amount || f.amountIn)) kind = f.category && (f.amount || hasBudget) ? 'budgets' : 'unknown';
  let budget = null, month = null;
  if (kind === 'budgets') {
    // aparte toewijzing: alleen categorie, bedrag en (optioneel) maand; de transactie-fallbacks (payee e.d.) hoeven hier niet
    const used = new Set(); const catI = byAlias('category', s => s.unique >= 1 && s.num < 0.5 && s.date < 0.5, used); if (catI >= 0) used.add(catI);
    let bi = byAlias('budget', s => s.num >= 0.5, used);
    if (bi < 0) bi = byAlias('amount', s => s.num >= 0.5, used);
    if (bi < 0) { let best = -1, bs = 0.5; stats.forEach((st, i) => { if (!used.has(i) && st.num > bs && st.date < 0.5) { bs = st.num; best = i; } }); bi = best; }
    if (bi >= 0) used.add(bi);
    const mi = byAlias('month', s => s.date >= 0.5 || s.vals.some(v => /^\d{4}-\d{2}$/.test(v)), used);
    for (const k of Object.keys(f)) f[k] = null;
    f.category = catI >= 0 ? table.headers[catI] : null; budget = bi >= 0 ? table.headers[bi] : null; month = mi >= 0 ? table.headers[mi] : null;
  }
  return {
    kind, fields: f, budget: { amount: budget, month }, sign: 'auto', dateOrder: detectDateOrder(f.date ? stats[idx(f.date)].vals : []),
    decimal: detectDecimalSep(f.amount ? stats[idx(f.amount)].vals : (f.amountOut ? [...stats[idx(f.amountOut)].vals, ...stats[idx(f.amountIn)].vals] : [])),
    columns: table.headers.map((h, i) => ({ name: h, date: +stats[i].date.toFixed(2), num: +stats[i].num.toFixed(2), unique: stats[i].unique })),
  };
}

// ---------------------------------------------------------------- categorie-koppeling
const SYNONYMS = {
  groceries: ['boodschap', 'supermarkt', 'grocer'], dining: ['uit eten', 'restaurant', 'horeca', 'eten en drinken', 'eten & drinken', 'takeaway', 'cafe', 'uiteten'],
  rent: ['huur', 'hypotheek', 'rent', 'mortgage'], energy: ['energie', 'stroom', 'elektra', 'gas', 'electric'], water: ['water'],
  telecom: ['internet', 'telefoon', 'mobiel', 'telecom', 'tv'], taxes: ['belasting', 'gemeente', 'heffing'], home: ['inrichting', 'klus', 'huishoud', 'meubel'],
  transit: ['openbaar', 'ov ', 'trein', 'bus', 'ov-'], fuel: ['benzine', 'brandstof', 'tanken', 'laden'], car: ['auto', 'parkeer', 'wegenbelasting'],
  healthins: ['zorgverzekering'], health: ['zorg', 'huisarts', 'tandarts', 'apotheek', 'medisch'], insurance: ['verzekering', 'insurance'],
  subscriptions: ['abonnement', 'streaming', 'subscription'], shopping: ['shopping', 'kleding', 'kleren', 'winkelen', 'webshop'],
  leisure: ['uitje', 'entertainment', 'hobby', 'vrije tijd', 'bioscoop', 'cultuur', 'uitgaan', 'recreatie'], travel: ['vakantie', 'reizen', 'travel', 'holiday'],
  sports: ['sport', 'fitness'], gifts: ['cadeau', 'gift', 'donatie', 'goede doel', 'schenking'], education: ['onderwijs', 'school', 'studie', 'kinderopvang'],
  bank: ['bankkosten', 'bank'], cash: ['contant', 'geldopname', 'pinnen'], other: ['overig', 'divers', 'other', 'misc', 'onbekend', 'diversen'],
  salary: ['salaris', 'loon', 'salary', 'wage'], benefits: ['toeslag', 'uitkering'], other_income: ['overig inkomen', 'terugbetaling', 'refund', 'inkomen', 'income'],
  transfer: ['sparen', 'spaar', 'overboek', 'transfer', 'savings'], invest: ['beleg', 'invest', 'pensioen', 'crypto', 'aandelen'], drugstore: ['drogist', 'verzorging', 'kapper', 'personal care'],
};
/** Zoek de bestaande categorie die bij een Notion-waarde past: exacte naam, dan synoniemen. */
export function matchCategory(value, cats) {
  const v = fold(value).trim(); if (!v) return null;
  const exact = cats.find(c => fold(c.name) === v); if (exact) return exact;
  const part = cats.find(c => v.length >= 4 && (fold(c.name).includes(v) || (fold(c.name).length >= 5 && v.includes(fold(c.name))))); if (part) return part;
  for (const [key, words] of Object.entries(SYNONYMS)) if (words.some(w => v === w.trim() || v.includes(w))) { const c = cats.find(x => x.key === key); if (c) return c; }
  return null;
}

// ---------------------------------------------------------------- plan
const INCOME_NAME = /inkomen|salaris|loon|income|salary|toeslag|uitkering|rente ontvangen/i;
const hashKey = s => createHash('sha1').update(s).digest('hex').slice(0, 20);

function resolveType(v) {
  const s = fold(v);
  if (/uitgave|expense|^af$|debit|kosten|betaling|uit$/.test(s)) return -1;
  if (/inkomst|income|^bij$|credit|ontvangst|^in$/.test(s)) return 1;
  return 0;
}

/**
 * Bouw een plan op basis van een tabel en configuratie. Schrijft niets.
 * cfg: { fields, sign: 'auto'|'as-is'|'expenses-positive'|'by-type', dateOrder, decimal, categoryMap, enrich, defaultAccount }
 */
export function buildPlan(db, table, cfg) {
  const F = cfg.fields || {}, col = n => (n ? table.headers.indexOf(n) : -1);
  const ci = Object.fromEntries(['date', 'amount', 'amountIn', 'amountOut', 'type', 'payee', 'description', 'notes', 'category', 'account'].map(k => [k, col(F[k])]));
  if (ci.date < 0) throw new Error('Kies de kolom met de datum.');
  if (ci.amount < 0 && !(ci.amountIn >= 0 && ci.amountOut >= 0)) throw new Error('Kies de kolom met het bedrag (of aparte kolommen voor inkomsten en uitgaven).');
  const dec = cfg.decimal || ',', order = cfg.dateOrder || 'dmy';
  const cell = (r, k) => (ci[k] >= 0 ? r[ci[k]] ?? '' : '');
  const errors = [], rows = [];
  const allAmounts = ci.amount >= 0 ? table.rows.map(r => parseLooseMoney(r[ci.amount], dec)).filter(v => v !== null) : [];
  const anyNegative = allAmounts.some(v => v < 0);
  const typeCol = ci.type >= 0;
  const sign = cfg.sign || 'auto';

  table.rows.forEach((r, n) => {
    const line = n + 2;
    const date = parseLooseDate(cell(r, 'date'), order);
    if (!date) { if (r.some(Boolean)) errors.push({ row: line, reason: `Datum niet herkend: "${cell(r, 'date')}"` }); return; }
    let amount;
    if (ci.amount >= 0) {
      amount = parseLooseMoney(cell(r, 'amount'), dec);
      if (amount === null) { errors.push({ row: line, reason: `Bedrag niet herkend: "${cell(r, 'amount')}"` }); return; }
    } else {
      const o = parseLooseMoney(cell(r, 'amountOut'), dec) ?? 0, i = parseLooseMoney(cell(r, 'amountIn'), dec) ?? 0;
      amount = Math.abs(i) - Math.abs(o);
      if (!o && !i) { errors.push({ row: line, reason: 'Geen bedrag in uitgaven- of inkomstenkolom' }); return; }
    }
    const category = firstOf(cell(r, 'category'));
    if (ci.amount >= 0) {
      const t = typeCol ? resolveType(cell(r, 'type')) : 0;
      if (sign === 'by-type' || (sign === 'auto' && t !== 0 && !anyNegative)) { if (t) amount = t * Math.abs(amount); }
      else if (sign === 'expenses-positive' || (sign === 'auto' && !anyNegative && !typeCol)) amount = INCOME_NAME.test(category) ? Math.abs(amount) : -Math.abs(amount);
      else if (sign === 'invert') amount = -amount;
    }
    if (amount === 0) { errors.push({ row: line, reason: 'Bedrag is 0' }); return; }
    let payee = cleanRelation(cell(r, 'payee')), description = cleanRelation(cell(r, 'description')), notes = cell(r, 'notes');
    if (!payee) payee = description.slice(0, 40) || category || 'Onbekend';
    if (description && description === payee) description = '';
    rows.push({ line, date, amount, payee, description: tidyDescription(description), notes, category, account: cleanRelation(cell(r, 'account')) });
  });

  // eigen rekeningen
  const accounts = db.prepare('SELECT id, iban, name FROM accounts').all();
  const resolveAccount = a => {
    if (!a) return cfg.defaultAccount ? accounts.find(x => x.id === Number(cfg.defaultAccount)) ?? null : null;
    const ib = a.replace(/\s+/g, '').toUpperCase();
    return accounts.find(x => x.iban === ib) || accounts.find(x => fold(x.name) === fold(a)) || { create: true, name: a, iban: /^[A-Z]{2}\d{2}[A-Z0-9]{8,}$/.test(ib) ? ib : 'NOTION-' + fold(a).replace(/[^a-z0-9]+/g, '-') };
  };
  for (const x of rows) x.acct = resolveAccount(x.account);

  // dubbelen binnen het bestand krijgen een volgnummer; eerdere Notion-imports worden herkend aan dezelfde sleutel
  const seen = new Map();
  for (const x of rows) {
    const base = [x.acct?.iban || x.acct?.name || '', x.date, x.amount, fold(x.payee), fold(x.description)].join('|');
    const n = (seen.get(base) || 0) + 1; seen.set(base, n); x.key = 'notion|' + hashKey(base + '#' + n);
  }
  const keyExists = db.prepare('SELECT 1 FROM transactions WHERE key=?');
  for (const x of rows) x.already = !!keyExists.get(x.key);

  // bestaande (bijv. Rabobank-)transacties verrijken: zelfde bedrag, datum ±3 dagen, één-op-één
  const existing = [];
  if (cfg.enrich !== false && rows.length) {
    const dates = rows.map(x => x.date).sort(), from = shiftDay(dates[0], -3), to = shiftDay(dates.at(-1), 3);
    for (const t of db.prepare(`SELECT id, date, amount, account_id, payee, description, category_id, confirmed, notes FROM transactions WHERE date>=? AND date<=? AND key NOT LIKE 'notion|%'`).all(from, to)) existing.push(t);
    const byAmount = new Map(); for (const t of existing) (byAmount.get(t.amount) || byAmount.set(t.amount, []).get(t.amount)).push(t);
    const cands = [];
    rows.forEach((x, i) => {
      if (x.already) return;
      for (const t of byAmount.get(x.amount) || []) {
        if (x.acct && !x.acct.create && t.account_id !== x.acct.id) continue;
        const dd = Math.abs(dayNum(t.date) - dayNum(x.date)); if (dd > 3) continue;
        cands.push({ i, t, dd, sim: similarity(x.payee + ' ' + x.description, t.payee + ' ' + t.description) });
      }
    });
    cands.sort((a, b) => a.dd - b.dd || b.sim - a.sim);
    const usedRow = new Set(), usedTx = new Set();
    for (const c of cands) if (!usedRow.has(c.i) && !usedTx.has(c.t.id)) { usedRow.add(c.i); usedTx.add(c.t.id); rows[c.i].match = c.t; }
  }

  // categorie-koppeling
  const cats = db.prepare('SELECT id, key, name, kind FROM categories').all();
  const values = new Map();
  for (const x of rows) if (x.category) { const v = values.get(x.category) || { value: x.category, count: 0, pos: 0 }; v.count++; if (x.amount > 0) v.pos++; values.set(x.category, v); }
  const categoryPlan = [...values.values()].sort((a, b) => b.count - a.count).map(v => {
    const chosen = cfg.categoryMap?.[v.value];
    let action;
    if (chosen?.type === 'none') action = { type: 'none' };
    else if (chosen?.type === 'existing' && cats.find(c => c.id === chosen.id)) action = { type: 'existing', id: chosen.id, name: cats.find(c => c.id === chosen.id).name };
    else if (chosen?.type === 'new') action = { type: 'new', name: chosen.name || v.value, kind: chosen.kind || 'expense' };
    else { const m = matchCategory(v.value, cats); action = m ? { type: 'existing', id: m.id, name: m.name, auto: true } : { type: 'new', name: v.value, kind: v.pos / v.count >= 0.6 ? 'income' : /spaar|overboek|transfer/i.test(v.value) ? 'transfer' : 'expense', auto: true }; }
    return { value: v.value, count: v.count, action };
  });

  const summary = {
    rows: table.rows.length, valid: rows.length, errors: errors.length,
    already: rows.filter(x => x.already).length,
    enrich: rows.filter(x => !x.already && x.match).length,
    added: rows.filter(x => !x.already && !x.match).length,
    from: rows.length ? rows.map(x => x.date).sort()[0] : null, to: rows.length ? rows.map(x => x.date).sort().at(-1) : null,
    income: rows.filter(x => x.amount > 0).reduce((a, x) => a + x.amount, 0), expenses: -rows.filter(x => x.amount < 0).reduce((a, x) => a + x.amount, 0),
    newCategories: categoryPlan.filter(c => c.action.type === 'new').length, newAccounts: new Set(rows.filter(x => x.acct?.create).map(x => x.acct.iban)).size,
  };
  return { summary, rows, errors, categoryPlan, preview: rows.slice(0, 12).map(x => ({ line: x.line, date: x.date, amount: x.amount, payee: x.payee, description: x.description, category: x.category, account: x.account,
    status: x.already ? 'bestaat al' : x.match ? 'verrijkt bestaande' : 'nieuw' })) };
}
const dayNum = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
const shiftDay = (d, n) => new Date((dayNum(d) + n) * 864e5).toISOString().slice(0, 10);
const words = s => new Set(fold(s).split(/[^a-z0-9]+/).filter(w => w.length > 2));
function similarity(a, b) { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); }

// ---------------------------------------------------------------- uitvoeren
/** Voer het plan uit: nieuwe transacties toevoegen, bestaande verrijken, categorieën aanmaken, en daarvan leren. */
export function applyPlan(db, plan, { name = '' } = {}) {
  const out = withTx(db, () => {
    const catId = new Map(); let createdCats = 0;
    for (const c of plan.categoryPlan) {
      const a = c.action;
      if (a.type === 'existing') catId.set(c.value, a.id);
      else if (a.type === 'new') {
        const ex = db.prepare('SELECT id FROM categories WHERE name=?').get(a.name);
        if (ex) catId.set(c.value, ex.id);
        else { catId.set(c.value, Number(db.prepare('INSERT INTO categories (name, kind, color, icon, grp) VALUES (?,?,?,?,?)').run(a.name, a.kind || 'expense', pickColor(createdCats), '🏷️', a.kind === 'income' ? 'Inkomen' : a.kind === 'transfer' ? 'Overboekingen' : 'Overig').lastInsertRowid)); createdCats++; }
      }
    }
    const accId = new Map();
    const getAcc = x => {
      if (!x) return null; if (!x.create) return x.id;
      if (accId.has(x.iban)) return accId.get(x.iban);
      const ex = db.prepare('SELECT id FROM accounts WHERE iban=?').get(x.iban);
      const id = ex ? ex.id : Number(db.prepare('INSERT INTO accounts (iban, name) VALUES (?,?)').run(x.iban, x.name).lastInsertRowid);
      accId.set(x.iban, id); return id;
    };
    const importId = Number(db.prepare('INSERT INTO imports (name) VALUES (?)').run(('Notion: ' + name).slice(0, 200)).lastInsertRowid);
    const ins = db.prepare(`INSERT OR IGNORE INTO transactions (date, amount, payee, description, account, account_id, counter_iban, code, seq, balance, merchant, key, import_id, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const pairs = []; let added = 0, enriched = 0, from = null, to = null;
    const chrono = [...plan.rows].sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line);
    for (const x of chrono) {
      if (x.already) continue;
      const cid = x.category ? catId.get(x.category) : null;
      if (x.match) {
        if (cid) pairs.push({ id: x.match.id, category_id: cid });
        if (x.notes && !x.match.notes) db.prepare('UPDATE transactions SET notes=? WHERE id=?').run(x.notes.slice(0, 500), x.match.id);
        enriched++; continue;
      }
      const aid = getAcc(x.acct); const ibanText = x.acct?.create ? x.acct.iban : x.acct?.iban || '';
      const r = ins.run(x.date, x.amount, displayName(x.payee), x.description, ibanText, aid, '', '', 0, null, merchantKey(x.payee, x.description), x.key, importId, (x.notes || '').slice(0, 500));
      if (r.changes) { added++; if (!from || x.date < from) from = x.date; if (!to || x.date > to) to = x.date; if (cid) pairs.push({ id: Number(r.lastInsertRowid), category_id: cid }); }
    }
    const learned = applyManual(db, pairs);
    if (added) db.prepare('UPDATE imports SET added=?, from_date=?, to_date=? WHERE id=?').run(added, from, to, importId);
    else db.prepare('DELETE FROM imports WHERE id=?').run(importId);
    return { added, enriched, learned, createdCategories: createdCats, importId: added ? importId : null, skipped: plan.rows.filter(x => x.already).length, errors: plan.errors.length };
  });
  out.recategorized = recategorize(db); // nieuwe transacties zonder Notion-categorie krijgen de automatische indeling
  return out;
}
const COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1'];
const pickColor = n => COLORS[n % COLORS.length];

// ---------------------------------------------------------------- budgetten
export function buildBudgetPlan(db, table, cfg) {
  const F = cfg.fields || {}, col = n => (n ? table.headers.indexOf(n) : -1);
  const cc = col(F.category), ac = col(cfg.budget?.amount || F.amount), mc = col(cfg.budget?.month);
  if (cc < 0 || ac < 0) throw new Error('Kies de kolom met de categorie en de kolom met het budgetbedrag.');
  const dec = cfg.decimal || ',', cats = db.prepare('SELECT id, key, name, kind FROM categories').all();
  const items = [], errors = [];
  table.rows.forEach((r, n) => {
    const value = firstOf(r[cc]); const cents = parseLooseMoney(r[ac], dec);
    if (!value || cents === null) { if (r.some(Boolean)) errors.push({ row: n + 2, reason: `Categorie of bedrag niet herkend (${r[cc]} / ${r[ac]})` }); return; }
    let month = '2000-01'; // zonder maandkolom: geldt vanaf het begin tot het wordt gewijzigd
    if (mc >= 0 && r[mc]) { const m = /^(\d{4})-(\d{2})$/.exec(r[mc].trim()); const d = m ? `${m[1]}-${m[2]}-01` : parseLooseDate(r[mc], cfg.dateOrder || 'dmy'); if (d) month = d.slice(0, 7); }
    const mapped = cfg.categoryMap?.[value];
    const cat = mapped?.type === 'existing' ? cats.find(c => c.id === mapped.id) : mapped?.type === 'none' ? null : matchCategory(value, cats);
    items.push({ line: n + 2, value, month, amount: Math.abs(cents), category: cat ? { id: cat.id, name: cat.name } : null });
  });
  return { items, errors, summary: { rows: table.rows.length, valid: items.filter(i => i.category).length, unmatched: items.filter(i => !i.category).length, errors: errors.length } };
}
export function applyBudgetPlan(db, plan) {
  return withTx(db, () => {
    const up = db.prepare('INSERT INTO budgets (category_id, month, amount) VALUES (?,?,?) ON CONFLICT(category_id, month) DO UPDATE SET amount=excluded.amount');
    let n = 0; for (const i of plan.items) if (i.category) { up.run(i.category.id, i.month, i.amount); n++; }
    return { budgets: n, skipped: plan.items.length - n };
  });
}

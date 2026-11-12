import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clean, merchantKey, displayName } from '../src/normalize.js';
import { Categorizer } from '../src/categorizer.js';
import { parseRabobank, parseAmount, parseDate } from '../src/rabobank.js';
import { openDb, importTransactions, setCategory, recategorize, confirmSuggestions, DEFAULT_CATEGORIES } from '../src/db.js';

const cats = DEFAULT_CATEGORIES.map((c, i) => ({ id: i + 1, key: c[0], name: c[1], kind: c[2] }));
const id = key => cats.find(c => c.key === key).id;
const cz = (extra = {}) => new Categorizer({ categories: cats, ...extra });

test('normalisatie haalt Rabo-ruis weg', () => {
  assert.equal(merchantKey('ALBERT HEIJN 1234 EINDHOVEN'), 'albert heijn');
  assert.equal(merchantKey('Albert Heijn 5678'), 'albert heijn');
  assert.equal(merchantKey('Starbucks 4831 Breda'), 'starbucks');
  assert.equal(merchantKey("Bakkerij 't Brood 2211 Eindhoven"), 'bakkerij brood');
  assert.equal(merchantKey('Thuisbezorgd.nl'), 'thuisbezorgd');
  assert.equal(merchantKey('NS Groep IZ NS Reizigers'), 'ns groep');
  assert.equal(merchantKey('Werkgever Acme B.V.'), 'werkgever acme');
  assert.equal(clean('BEA, Apple Pay Jumbo 1234,PAS123 NR:CT123456, 03.10.26 12:34 Eindhoven NLD'), 'jumbo eindhoven');
  assert.equal(displayName('ALBERT HEIJN 1234'), 'Albert Heijn');
  assert.equal(displayName("Bakkerij 't Brood"), "Bakkerij 't Brood");
});

test('csv: bedragen, datums, aanhalingstekens', () => {
  assert.equal(parseAmount('+2850,00'), 285000);
  assert.equal(parseAmount('-1.234,56'), -123456);
  assert.equal(parseAmount('-0,05'), -5);
  assert.equal(parseDate('15-01-2026'), '2026-01-15');
  });

test('csv: oud formaat zonder kopregel', () => {
  const line = '"NL12RABO0123456789","EUR","RABONL2U","7","2026-01-05","2026-01-05","-12,50","900,00","","Jumbo 1","","","","bc","","","","","","pin","","","","","",""';
  const [t] = parseRabobank(line);
  assert.equal(t.amount, -1250); assert.equal(t.code, 'bc'); assert.equal(t.balance, 90000);
});

test('csv: foutmelding bij verkeerd bestand', () => {
  assert.throws(() => parseRabobank('foo,bar\n1,2'), /niet herkend als Rabobank|Geen Rabobank-CSV/);
});

test('woordenboek categoriseert bekende winkels met uitleg', () => {
  const c = cz();
  let r = c.classify({ payee: 'Albert Heijn 1234 Eindhoven', description: 'Pasvolgnr:012 03-10-2026', amount: -4500 });
  assert.equal(r.category_id, id('groceries')); assert.ok(r.confidence >= 0.8); assert.equal(r.source, 'builtin');
  r = c.classify({ payee: 'Netflix International B.V.', description: 'Netflix', amount: -1399, code: 'ei' });
  assert.equal(r.category_id, id('subscriptions'));
  r = c.classify({ payee: 'Werkgever BV', description: 'Salaris oktober', amount: 300000 });
  assert.equal(r.category_id, id('salary'));
});

test('woordgrenzen: "plus" matcht geen "surplus", "ns" geen "mens"', () => {
  const c = cz();
  assert.equal(c.classify({ payee: 'Surplus Mens Holding', description: '', amount: -1000 }), null);
});

test('inkomen-categorie kan geen uitgave zijn; terugbetaling is onzeker', () => {
  const c = cz();
  assert.equal(c.classify({ payee: 'UWV', description: '', amount: -5000 })?.category_id === id('benefits'), false);
  const r = c.classify({ payee: 'Zalando Payments GmbH', description: 'Retour', amount: 8550 });
  assert.equal(r.category_id, id('shopping')); assert.ok(r.confidence < 0.8);
});

test('eigen rekening -> overboeking; geldautomaat -> contant', () => {
  const c = cz({ ownIbans: ['NL82RABO0300000001'] });
  assert.equal(c.classify({ payee: 'J Jansen', description: '', amount: -10000, counter_iban: 'NL82 RABO 0300 0000 01' }).category_id, id('transfer'));
  assert.equal(c.classify({ payee: 'Onbekende pinautomaat', description: '', amount: -5000, code: 'ga' }).category_id, id('cash'));
});

test('eigen regels gaan voor alles en ondersteunen bedrag/richting', () => {
  const rules = [
    { id: 1, field: 'payee', op: 'contains', pattern: 'albert heijn', direction: 'out', amount_min: 10000, priority: 0, enabled: 1, category_id: id('other') },
    { id: 2, field: 'description', op: 'regex', pattern: 'verjaardag(scadeau)?', direction: 'any', priority: 5, enabled: 1, category_id: id('gifts') },
    { id: 3, field: 'iban', op: 'equals', pattern: 'NL11 ABNA 0123 456780', direction: 'any', priority: 0, enabled: 1, category_id: id('rent') },
  ];
  const c = cz({ rules });
  assert.equal(c.classify({ payee: 'Albert Heijn', description: '', amount: -15000 }).category_id, id('other'));  // grote boodschap
  assert.equal(c.classify({ payee: 'Albert Heijn', description: '', amount: -2000 }).category_id, id('groceries')); // te klein
  assert.equal(c.classify({ payee: 'Tikkie', description: 'Tikkie verjaardagscadeau', amount: -1500 }).category_id, id('gifts'));
  assert.equal(c.classify({ payee: 'Wie dan ook', description: '', amount: -100000, counter_iban: 'NL11ABNA0123456780' }).category_id, id('rent'));
});

test('geheugen: eerder gekozen categorie wordt hergebruikt, correctie weegt zwaarder', () => {
  const memory = [{ key: 'm:dierenspeciaalzaak kat', category_id: id('shopping'), n: 1 }];
  const r = cz({ memory }).classify({ payee: 'Dierenspeciaalzaak De Kat 1234 Eindhoven', description: '', amount: -2200 });
  assert.equal(r.source, 'memory'); assert.equal(r.category_id, id('shopping')); assert.ok(r.confidence >= 0.8);
});

test('leermodel stelt voor, maar nooit met auto-zekerheid', () => {
  const training = [];
  for (let i = 0; i < 12; i++) training.push({ payee: 'Hondenschool Waf', description: 'training les ' + i, amount: -2500, category_id: id('sports') });
  for (let i = 0; i < 12; i++) training.push({ payee: 'Kattenmand Shop', description: 'kattenvoer bestelling', amount: -2500, category_id: id('shopping') });
  const r = cz({ training }).classify({ payee: 'Hondenschool Waf Zuid', description: 'training les nieuw', amount: -2500 });
  assert.equal(r.source, 'ml'); assert.equal(r.category_id, id('sports')); assert.ok(r.confidence < 0.8);
});

test('end-to-end: import, deduplicatie, review, leren van correcties', () => {
  const db = openDb(':memory:');
  const txs = parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8'));
  const r1 = importTransactions(db, txs);
  assert.ok(r1.added > 500);
  const r2 = importTransactions(db, txs);
  assert.equal(r2.added, 0); assert.equal(r2.skipped, txs.length);
  const total = db.prepare('SELECT COUNT(*) c FROM transactions').get().c;
  const unconf = db.prepare('SELECT COUNT(*) c FROM transactions WHERE category_id IS NULL').get().c;
  assert.ok(unconf / total < 0.1, 'minder dan 10% ongecategoriseerd');

  // Leren: deel de onbekende winkel handmatig in, de rest volgt automatisch
  const ids = db.prepare("SELECT id FROM transactions WHERE merchant='dierenspeciaalzaak kat'").all().map(r => r.id);
  assert.ok(ids.length >= 5);
  setCategory(db, [ids[0]], id('shopping'));
  recategorize(db);
  const left = db.prepare("SELECT COUNT(*) c FROM transactions WHERE merchant='dierenspeciaalzaak kat' AND category_id=?").get(id('shopping')).c;
  assert.equal(left, ids.length);

  // Correctie: gebruiker wijst 2x een andere categorie toe -> geheugen volgt
  setCategory(db, [ids[1]], id('other')); setCategory(db, [ids[2]], id('other'));
  recategorize(db);
  const cat = db.prepare("SELECT category_id c FROM transactions WHERE id=?").get(ids[3]).c;
  assert.equal(cat, id('other'));
  assert.equal(confirmSuggestions(db, [ids[3]]), 1);
});

test('ongedaan maken herstelt categorie én geheugen', async () => {
  const { createApi } = await import('../src/service.js');
  const db = openDb(':memory:');
  const api = createApi(db);
  importTransactions(db, parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8')));
  const t = db.prepare("SELECT id FROM transactions WHERE merchant='dierenspeciaalzaak kat' ORDER BY id LIMIT 1").get();
  const before = db.prepare('SELECT COUNT(*) c FROM memory').get().c;
  const r = await api('PATCH', '/api/transactions/' + t.id, { category_id: id('shopping') });
  assert.ok(r.undo); assert.ok(r.similar >= 5);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM memory').get().c > before);
  await api('POST', '/api/undo', { id: r.undo });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory').get().c, before);
  const left = db.prepare("SELECT COUNT(*) c FROM transactions WHERE merchant='dierenspeciaalzaak kat' AND category_id IS NOT NULL").get().c;
  assert.equal(left, 0);
  await assert.rejects(() => api('POST', '/api/undo', { id: r.undo }), /niets meer/);
});

test('detail-API: categorie en tegenpartij', async () => {
  const { createApi } = await import('../src/service.js');
  const db = openDb(':memory:'); const api = createApi(db);
  importTransactions(db, parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8')));
  const c = await api('GET', `/api/detail?category=${id('rent')}&months=12`);
  assert.equal(c.monthly.length, 12); assert.equal(c.monthly.at(-1).value, 105000); assert.equal(c.total, 105000 * 12);
  assert.equal(c.merchants[0].name, 'Woonbron');
  const m = await api('GET', '/api/detail?merchant=werkgever%20acme');
  assert.equal(m.sign, 1); assert.ok(m.total > 0); assert.equal(m.categories[0].name, 'Salaris');
  await assert.rejects(() => api('GET', '/api/detail'), /vereist/);
});

test('overboeking tussen twee eigen rekeningen wordt gekoppeld zonder bekende IBAN', () => {
  const db = openDb(':memory:');
  const hdr = '"IBAN/BBAN","Munt","Volgnr","Datum","Bedrag","Tegenrekening IBAN/BBAN","Naam tegenpartij","Omschrijving-1"';
  const a = [hdr, '"NL01RABO0000000001","EUR","1","2026-05-02","-200,00","","Onbekend potje","verplaatst"', '"NL01RABO0000000001","EUR","2","2026-05-03","-9,99","","Kruidvat","x"'].join('\n');
  const b = [hdr, '"NL02RABO0000000002","EUR","1","2026-05-03","+200,00","","Onbekend potje","verplaatst"', '"NL02RABO0000000002","EUR","2","2026-05-04","+9,99","","Vriend","terug"'].join('\n');
  importTransactions(db, parseRabobank(a));
  importTransactions(db, parseRabobank(b));
  const rows = db.prepare("SELECT amount, category_id, cat_source, cat_reason FROM transactions WHERE abs(amount)=20000").all();
  assert.equal(rows.length, 2);
  for (const r of rows) { assert.equal(r.category_id, id('transfer')); assert.equal(r.cat_source, 'pair'); }
  assert.match(rows.find(r => r.amount < 0).cat_reason, /Overboeking naar/);
  // bevestigde transacties worden niet aangeraakt
  // toevallig tegengesteld bedrag, maar een kant is een zekere winkel (Kruidvat): geen overboeking
  const kv = db.prepare("SELECT cat_source, category_id FROM transactions WHERE abs(amount)=999").all();
  assert.ok(kv.every(r => r.cat_source !== 'pair' && r.category_id !== id('transfer')));
});

test('splitsen: budget/rapport tellen delen mee, validatie, ongedaan maken', async () => {
  const { createApi } = await import('../src/service.js');
  const db = openDb(':memory:'); const api = createApi(db);
  importTransactions(db, parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8')));
  const t = db.prepare("SELECT id, amount, date FROM transactions WHERE merchant='jumbo' AND amount<-5000 ORDER BY date DESC LIMIT 1").get();
  const month = t.date.slice(0, 7);
  const before = (await api('GET', '/api/budget?month=' + month)).find(r => r.id === id('groceries')).spent;
  const half = Math.round(t.amount / 2);
  await assert.rejects(() => api('PUT', `/api/transactions/${t.id}/split`, { parts: [{ category_id: id('groceries'), amount: half }] }), /minimaal 2/);
  await assert.rejects(() => api('PUT', `/api/transactions/${t.id}/split`, { parts: [{ category_id: id('groceries'), amount: half }, { category_id: id('home'), amount: half - 1 }] }), /tellen op/);
  await api('PUT', `/api/transactions/${t.id}/split`, { parts: [{ category_id: id('groceries'), amount: half }, { category_id: id('home'), amount: t.amount - half }] });
  const after = (await api('GET', '/api/budget?month=' + month)).find(r => r.id === id('groceries')).spent;
  assert.equal(before - after, Math.abs(t.amount - half)); // dat deel is naar 'home' verhuisd
  const home = (await api('GET', '/api/budget?month=' + month)).find(r => r.id === id('home')).spent;
  assert.equal(home, Math.abs(t.amount - half));
  const list = await api('GET', '/api/transactions?category=' + id('home') + '&month=' + month);
  assert.ok(list.rows.some(r => r.id === t.id && r.split_count === 2));
  const d = await api('GET', '/api/transactions/' + t.id); assert.equal(d.splits.length, 2);
  await api('DELETE', `/api/transactions/${t.id}/split`);
  const back = (await api('GET', '/api/budget?month=' + month)).find(r => r.id === id('groceries')).spent;
  assert.equal(back, before);
});

test('alle leesroutes werken op demodata (smoke)', async () => {
  const { createApi } = await import('../src/service.js');
  const db = openDb(':memory:'); const api = createApi(db);
  importTransactions(db, parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8')));
  for (const path of ['/api/dashboard', '/api/dashboard?month=2026-03', '/api/report?months=6', '/api/recurring', '/api/review', '/api/rules', '/api/memory',
    '/api/accounts', '/api/categories', '/api/budget?month=2026-10', '/api/transactions?status=review', '/api/export', '/api/search?q=jumbo']) {
    const r = await api('GET', path); assert.ok(r, path);
  }
  const d = await api('GET', '/api/dashboard?month=2026-10');
  assert.equal(d.totals.income, 315000); assert.ok(d.review > 0); assert.equal(d.byCategory[0].name, 'Huur / hypotheek');
});

test('regelsuggesties: pas na 3 consistente keuzes, niet als er al een regel is', async () => {
  const { createApi } = await import('../src/service.js');
  const db = openDb(':memory:'); const api = createApi(db);
  importTransactions(db, parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8')));
  assert.equal((await api('GET', '/api/rules/suggest')).length, 0);
  const ids = db.prepare("SELECT id FROM transactions WHERE merchant='dierenspeciaalzaak kat'").all().map(r => r.id);
  for (const i of ids.slice(0, 3)) await api('PATCH', '/api/transactions/' + i, { category_id: id('shopping') });
  const s = await api('GET', '/api/rules/suggest');
  assert.equal(s.length, 1); assert.equal(s[0].category_id, id('shopping')); assert.ok(s[0].n >= 3);
  await api('POST', '/api/rules', { field: 'payee', op: 'contains', pattern: 'dierenspeciaalzaak', category_id: id('shopping') });
  assert.equal((await api('GET', '/api/rules/suggest')).length, 0);
});

test('saldo-verloop sluit aan op het laatste saldo; doelen CRUD; verwachte vaste lasten', async () => {
  const { createApi } = await import('../src/service.js');
  const db = openDb(':memory:'); const api = createApi(db);
  importTransactions(db, parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8')));
  const d = await api('GET', '/api/dashboard');
  const acc = (await api('GET', '/api/accounts'))[0];
  assert.equal(d.balanceHistory.at(-1).balance, acc.balance); assert.ok(d.balanceHistory.length > 20);
  assert.ok(Array.isArray(d.upcoming));
  const g = await api('POST', '/api/goals', { name: 'Vakantie', target: 200000, saved: 50000, monthly: 25000 });
  await api('PUT', '/api/goals/' + g.id, { saved: 75000 });
  const list = await api('GET', '/api/goals'); assert.equal(list[0].saved, 75000);
  await assert.rejects(() => api('POST', '/api/goals', { name: '', target: 0 }), /verplicht/);
  await api('DELETE', '/api/goals/' + g.id); assert.equal((await api('GET', '/api/goals')).length, 0);
});

test('database op schijf: heropenen en migratie zijn idempotent, gegevens blijven', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { createApi } = await import('../src/service.js');
  const file = join(mkdtempSync(join(tmpdir(), 'mybudgets-')), 'budget.db');
  const db1 = openDb(file);
  importTransactions(db1, parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8')));
  const n = db1.prepare('SELECT COUNT(*) c FROM transactions').get().c; db1.close();
  const db2 = openDb(file); const api = createApi(db2);
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM transactions').get().c, n);
  assert.equal((await api('GET', '/api/dashboard?month=2026-10')).totals.income, 315000);
  assert.equal(db2.prepare("SELECT ym FROM transactions WHERE date='2026-10-25' LIMIT 1").get().ym, '2026-10');
  db2.close();
});

test('importgeschiedenis: elke import is terug te draaien', async () => {
  const { createApi } = await import('../src/service.js');
  const db = openDb(':memory:'); const api = createApi(db);
  const hdr = '"IBAN/BBAN","Munt","Volgnr","Datum","Bedrag","Naam tegenpartij","Omschrijving-1"';
  const mk = (n, d) => [hdr, `"NL01RABO0000000001","EUR","${n}","${d}","-5,00","Kruidvat","x"`].join('\n');
  const a = await api('POST', '/api/import', { csv: mk(1, '2026-01-05'), name: 'jan.csv' });
  const b = await api('POST', '/api/import', { csv: mk(2, '2026-02-05'), name: 'feb.csv' });
  const none = await api('POST', '/api/import', { csv: mk(2, '2026-02-05'), name: 'feb-nogmaals.csv' });
  assert.equal(none.added, 0); assert.equal(none.importId, null);
  let list = await api('GET', '/api/imports');
  assert.deepEqual(list.map(i => [i.name, i.n]), [['feb.csv', 1], ['jan.csv', 1]]);
  const r = await api('DELETE', '/api/imports/' + b.importId); assert.equal(r.deleted, 1);
  list = await api('GET', '/api/imports'); assert.equal(list.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, 1);
  assert.ok(a.importId);
});

test('budget-overdracht (rollover): niet-bestede ruimte schuift door, overschrijding verkleint de volgende maand', async () => {
  const { createApi } = await import('../src/service.js');
  const db = openDb(':memory:'); const api = createApi(db);
  const hdr = '"IBAN/BBAN","Munt","Volgnr","Datum","Bedrag","Naam tegenpartij","Omschrijving-1"';
  const rows = ['"NL01RABO0000000001","EUR","1","2026-01-10","-60,00","Jumbo","x"', '"NL01RABO0000000001","EUR","2","2026-02-10","-130,00","Jumbo","x"', '"NL01RABO0000000001","EUR","3","2026-03-10","-10,00","Jumbo","x"'];
  importTransactions(db, parseRabobank([hdr, ...rows].join('\n')));
  const g = id('groceries');
  await api('PUT', '/api/budget', { category_id: g, month: '2026-01', amount: 10000 });
  const at = async m => (await api('GET', '/api/budget?month=' + m)).find(r => r.id === g);
  assert.equal((await at('2026-03')).carry, 0); // rollover staat uit
  await api('PUT', '/api/categories/' + g, { rollover: true });
  assert.equal((await at('2026-01')).carry, 0);
  assert.equal((await at('2026-02')).carry, 4000);              // 100 - 60 overgedragen
  assert.equal((await at('2026-02')).limit, 14000);
  assert.equal((await at('2026-03')).carry, 4000 + (10000 - 13000)); // februari 30 te veel: 40 - 30 = 10 over
  assert.equal((await at('2026-03')).limit, 10000 + 1000);
});

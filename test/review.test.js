// Regressietests voor de review-ronde: validatie, randgevallen en robuustheid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, importTransactions } from '../src/db.js';
import { parseRabobank } from '../src/rabobank.js';
import { createApi } from '../src/service.js';
import { addMonths, daysIn, addDays, dayNum, normIban, clampInt } from '../src/util.js';

const demo = () => { const db = openDb(':memory:'); importTransactions(db, parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8'))); return { db, api: createApi(db) }; };
const status = p => p.then(() => 200, e => e.status || 500);

test('util: maanden, dagen, IBAN, klemmen', () => {
  assert.equal(addMonths('2026-01', -1), '2025-12'); assert.equal(addMonths('2026-11', 14), '2028-01');
  assert.equal(daysIn('2028-02'), 29); assert.equal(addDays('2026-02-27', 3), '2026-03-02'); assert.equal(dayNum('1970-01-02'), 1);
  assert.equal(normIban(' nl12 rabo 0123 4567 89 '), 'NL12RABO0123456789');
  assert.equal(clampInt('-5', 1, 10, 3), 1); assert.equal(clampInt('2.7', 1, 10, 3), 2); assert.equal(clampInt('x', 1, 10, 3), 3); assert.equal(clampInt('99', 1, 10, 3), 10);
});

test('categorieën: validatie geeft 400 i.p.v. een databasefout', async () => {
  const { api } = demo();
  assert.equal(await status(api('POST', '/api/categories', { name: '  ' })), 400);
  assert.equal(await status(api('POST', '/api/categories', { name: 'X', kind: 'raar' })), 400);
  assert.equal(await status(api('POST', '/api/categories', { name: 'X', color: 'rood' })), 400);
  assert.equal(await status(api('PUT', '/api/categories/1', { name: '' })), 400);
  assert.equal(await status(api('PUT', '/api/categories/99999', { name: 'Y' })), 400);
  assert.equal(await status(api('POST', '/api/categories', { name: 'Boodschappen' })), 409);       // bestaat al
  const ok = await api('POST', '/api/categories', { name: 'Huisdieren', kind: 'expense', color: '#123abc' }); assert.ok(ok.id);
  await api('PUT', `/api/categories/${ok.id}`, { icon: '🐾', rollover: true });                       // gedeeltelijke update
});

test('budget en doelen: onbekende categorie en ongeldig streefbedrag', async () => {
  const { api } = demo();
  assert.equal(await status(api('PUT', '/api/budget', { category_id: 99999, month: '2026-10', amount: 100 })), 400);
  const g = await api('POST', '/api/goals', { name: 'Fiets', target: 50000 });
  assert.equal(await status(api('PUT', `/api/goals/${g.id}`, { target: 0 })), 400);
  assert.equal(await status(api('PUT', `/api/goals/${g.id}`, { name: ' ' })), 400);
  assert.equal(await status(api('PUT', `/api/goals/${g.id}`, { saved: 1000 })), 200);
});

test('transactielijst: limit/offset worden geklemd (negatief betekent niet "alles")', async () => {
  const { api } = demo();
  assert.equal((await api('GET', '/api/transactions?limit=-5')).rows.length, 1);
  assert.equal((await api('GET', '/api/transactions?limit=2.7')).rows.length, 2);
  assert.equal((await api('GET', '/api/transactions?limit=99999')).rows.length, 622);   // geklemd op 2000; de demo heeft er 622
  assert.equal((await api('GET', '/api/transactions?limit=10&offset=-3')).rows.length, 10);
});

test('ongedaan maken blijft werken als de categorie intussen is verwijderd', async () => {
  const { db, api } = demo();
  const c = await api('POST', '/api/categories', { name: 'Tijdelijk' });
  const t = db.prepare("SELECT id FROM transactions WHERE merchant='kapper jansen' LIMIT 1").get();
  const r = await api('PATCH', '/api/transactions/' + t.id, { category_id: c.id });
  const r2 = await api('PATCH', '/api/transactions/' + t.id, { category_id: 1 });
  await api('DELETE', '/api/categories/' + c.id);
  await api('POST', '/api/undo', { id: r2.undo });           // terug naar 'Tijdelijk' — bestaat niet meer
  const row = db.prepare('SELECT category_id, confirmed FROM transactions WHERE id=?').get(t.id);
  assert.notEqual(row.category_id, c.id); assert.equal(row.confirmed, 0);
  assert.ok(r.undo);
});

test('alles wissen is volledig (ook genegeerde vaste lasten) en laat categorieën/regels staan', async () => {
  const { db, api } = demo();
  await api('POST', '/api/recurring/ignore', { merchant: 'basic fit', name: 'Basic-Fit' });
  await api('POST', '/api/rules', { field: 'payee', op: 'contains', pattern: 'xyz', category_id: 1 });
  assert.equal(await status(api('POST', '/api/reset', { confirm: 'nee' })), 400);
  await api('POST', '/api/reset', { confirm: 'WISSEN' });
  for (const t of ['transactions', 'accounts', 'memory', 'imports', 'ignored_recurring']) assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, 0, t);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM categories').get().c > 20); assert.equal(db.prepare('SELECT COUNT(*) c FROM rules').get().c, 1);
});

test('rekening hernoemen: lengte begrensd, lege naam wordt "Rekening"', async () => {
  const { db, api } = demo();
  const id = db.prepare('SELECT id FROM accounts').get().id;
  await api('PUT', '/api/accounts/' + id, { name: 'x'.repeat(200) }); assert.equal(db.prepare('SELECT name FROM accounts').get().name.length, 80);
  await api('PUT', '/api/accounts/' + id, { name: '   ' }); assert.equal(db.prepare('SELECT name FROM accounts').get().name, 'Rekening');
});

test('jaaroverzicht: totalen, vergelijking met dezelfde periode vorig jaar, categorieën en verloop', async () => {
  const { api } = demo();
  const y = await api('GET', '/api/year');                       // standaard: laatste jaar met data
  assert.equal(y.year, '2026'); assert.deepEqual(y.years, ['2026', '2025']); assert.equal(y.partial, true); assert.equal(y.to, '2026-11-12');
  assert.equal(y.months.length, 12); assert.equal(y.months[9].income, 315000);              // oktober: salaris
  assert.equal(y.months.reduce((a, m) => a + m.expenses, 0), y.totals.expenses);
  assert.equal(y.txCount, 454);
  assert.ok(y.prevTotals.expenses > 0); assert.equal(y.prevComplete, false);                  // 2025 begint in de demo pas in september: geen eerlijke vergelijking
  assert.equal(y.byCategory[0].name, 'Huur / hypotheek'); assert.ok(y.byCategory.reduce((a, c) => a + c.value, 0) >= y.totals.expenses);   // categorieën met netto-terugbetaling staan niet in de lijst
  assert.equal(y.income[0].name, 'Salaris'); assert.equal(y.topPayees[0].payee, 'Woonbron'); assert.equal(y.biggest.length, 10);
  const cm = y.catMonths[y.byCategory[0].id]; assert.equal(cm.length, 12); assert.equal(cm[0], 105000);
  const old = await api('GET', '/api/year?year=2025'); assert.equal(old.prevComplete, false); assert.equal(old.partial, false); assert.equal(old.to, '2025-12-31');
  assert.equal((await api('GET', '/api/year?year=abc')).year, '2026');                       // ongeldig → laatste jaar
});

test('jaaroverzicht: vergelijking met vorig jaar zodra dat vanaf januari data heeft (zelfde periode bij lopend jaar)', async () => {
  const db = openDb(':memory:'), api = createApi(db);
  const hdr = '"IBAN/BBAN","Munt","Volgnr","Datum","Bedrag","Naam tegenpartij","Omschrijving-1"';
  const rows = [['2025-01-10', '-100,00'], ['2025-02-10', '-100,00'], ['2025-08-10', '-500,00'], ['2026-01-10', '-150,00'], ['2026-02-10', '-150,00']]
    .map(([d, a], i) => `"NL01RABO0000000001","EUR","${i + 1}","${d}","${a}","Jumbo","x"`);
  importTransactions(db, parseRabobank([hdr, ...rows].join('\n')));
  const y = await api('GET', '/api/year?year=2026');
  assert.equal(y.prevComplete, true); assert.equal(y.to, '2026-02-10');
  assert.equal(y.totals.expenses, 30000); assert.equal(y.prevTotals.expenses, 20000);    // 2025 t/m 10 feb; de 500 in augustus telt niet mee
});

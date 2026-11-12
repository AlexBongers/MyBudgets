// Regressietests voor de review-ronde: validatie, randgevallen en robuustheid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, importTransactions } from '../src/db.js';
import { parseRabobank } from '../src/rabobank.js';
import { createApi } from '../src/service.js';
import { loadTables, guessMapping, buildPlan } from '../src/notion.js';
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
  assert.equal((await api('GET', '/api/transactions?limit=99999')).rows.length, 622 > 2000 ? 2000 : 622);
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

test('Notion: rij met onbekend Type in een tabel zonder minbedragen wordt uitgave, niet inkomen', () => {
  const db = openDb(':memory:');
  const csv = ['Naam,Datum,Bedrag,Type', 'A,2026-01-05,"10,00",Uitgave', 'B,2026-01-06,"20,00",Inkomsten', 'C,2026-01-07,"30,00",???', 'D,2026-01-08,"40,00",'].join('\n');
  const t = loadTables(Buffer.from(csv), 'x.csv')[0], g = guessMapping(t);
  const p = buildPlan(db, t, { fields: g.fields, decimal: g.decimal, sign: 'auto' });
  assert.deepEqual(p.rows.map(r => [r.payee, r.amount]), [['A', -1000], ['B', 2000], ['C', -3000], ['D', -4000]]);
});

test('Notion: fouten in het budgetvoorbeeld geven 400 (geen 500)', async () => {
  const db = openDb(':memory:'), api = createApi(db);
  const body = { base64: Buffer.from('Categorie,Budget\nBoodschappen,450').toString('base64'), name: 'b.csv', table: 'b', kind: 'budgets', config: { fields: {}, budget: {} } };
  assert.equal(await status(api('POST', '/api/notion/plan', body)), 400);
});

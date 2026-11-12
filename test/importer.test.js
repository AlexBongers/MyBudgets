import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readZip, writeZip } from '../src/zip.js';
import { loadTables, guessMapping, parseLooseDate, parseLooseMoney, detectDecimalSep, detectDateOrder, matchCategory, buildPlan, applyPlan, buildBudgetPlan, applyBudgetPlan } from '../src/importer.js';
import { openDb, importTransactions, DEFAULT_CATEGORIES } from '../src/db.js';
import { parseRabobank } from '../src/rabobank.js';
import { createApi } from '../src/service.js';
import { buildActualDb } from '../samples/make-actual-demo.js';

const demoTxs = () => parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8'));
const actualZip = (opts) => writeZip({ 'My-Finances/db.sqlite': buildActualDb(demoTxs(), opts), 'My-Finances/metadata.json': '{}' });
const cfgOf = t => { const g = guessMapping(t); return { fields: g.fields, decimal: g.decimal, dateOrder: g.dateOrder, sign: 'as-is' }; };
const status = p => p.then(() => 200, e => e.status || 500);

test('datums: NL, EN, ISO, bereiken, dubbelzinnig', () => {
  assert.equal(parseLooseDate('12 november 2026'), '2026-11-12'); assert.equal(parseLooseDate('November 12, 2026'), '2026-11-12');
  assert.equal(parseLooseDate('3 mrt 2026'), '2026-03-03'); assert.equal(parseLooseDate('2026-11-12T09:00:00.000Z'), '2026-11-12');
  assert.equal(parseLooseDate('03/04/2026'), '2026-04-03'); assert.equal(parseLooseDate('03/04/2026', 'mdy'), '2026-03-04');
  assert.equal(parseLooseDate('31-02-2026'), null); assert.equal(parseLooseDate('ooit'), null);
  assert.equal(detectDateOrder(['03/25/2026', '01/02/2026']), 'mdy'); assert.equal(detectDateOrder(['25/03/2026']), 'dmy');
});

test('bedragen: NL/EN notatie, valuta, min, haakjes, spaties', () => {
  assert.equal(parseLooseMoney('€1.234,56', ','), 123456); assert.equal(parseLooseMoney('-€1,234.50', '.'), -123450); assert.equal(parseLooseMoney('(12,00)'), -1200);
  assert.equal(parseLooseMoney('12,00-'), -1200); assert.equal(parseLooseMoney('−45,10'), -4510); assert.equal(parseLooseMoney('1 234,50 EUR'), 123450);
  assert.equal(parseLooseMoney('12.5', '.'), 1250); assert.equal(parseLooseMoney('1.234', ','), 123400); assert.equal(parseLooseMoney('abc'), null);
  assert.equal(detectDecimalSep(['€1,234.50', '€12.00', '€3.5']), '.'); assert.equal(detectDecimalSep(['€1.234,50', '€12,00']), ',');
});

const cats = DEFAULT_CATEGORIES.map((c, i) => ({ id: i + 1, key: c[0], name: c[1], kind: c[2] }));
test('categorie-koppeling via naam en synoniemen (NL en EN)', () => {
  const id = v => matchCategory(v, cats)?.key;
  assert.equal(id('Boodschappen'), 'groceries'); assert.equal(id('Supermarkt'), 'groceries'); assert.equal(id('uit eten'), 'dining');
  assert.equal(id('Zorgverzekering'), 'healthins'); assert.equal(id('Benzine'), 'fuel'); assert.equal(id('Salaris'), 'salary'); assert.equal(id('Overboeking'), 'transfer');
  assert.equal(id('Iets raars'), undefined);
});

test('zip lezen: deflate, geneste mappen, __MACOSX genegeerd, kapotte zip', () => {
  const z = readZip(writeZip({ 'Export/a.txt': 'hoi', 'Export/Sub/b.txt': 'x', '__MACOSX/._a.txt': 'junk' }));
  assert.deepEqual(z.map(e => e.name).sort(), ['Export/Sub/b.txt', 'Export/a.txt']);
  assert.throws(() => readZip(Buffer.from('PK\x03\x04 niet echt')), /ZIP/);
});

test('Actual-export: ZIP en losse db.sqlite worden gelezen; verkeerde bestanden geven een duidelijke fout', () => {
  const t = loadTables(actualZip()); assert.deepEqual(t.map(x => x.name), ['Transacties', 'Budgetten']);
  assert.equal(t[0].rows.length, 622); assert.equal(t[0].decimal, '.');
  assert.deepEqual(t[0].headers, ['Datum', 'Bedrag', 'Tegenpartij', 'Omschrijving', 'Categorie', 'Rekening', 'Notities']);
  const raw = loadTables(buildActualDb(demoTxs())); assert.equal(raw[0].rows.length, 622);
  assert.throws(() => loadTables(Buffer.from('Naam,Datum\nA,B')), /geen Actual Budget-export/);
  assert.throws(() => loadTables(writeZip({ 'a.csv': 'x,y\n1,2' })), /db\.sqlite/);
});

test('Actual: transacties worden juist vertaald (datum, bedrag, categorie, tegenpartij, overboeking, notitie)', () => {
  const [t] = loadTables(actualZip()), g = guessMapping(t);
  assert.equal(g.kind, 'transactions'); assert.equal(g.fields.date, 'Datum'); assert.equal(g.fields.amount, 'Bedrag'); assert.equal(g.fields.category, 'Categorie'); assert.equal(g.fields.account, 'Rekening');
  const row = t.rows.find(r => r[2] === 'Woonbron'); assert.deepEqual([row[1], row[4], row[5]], ['-1050.00', 'Rent', 'Betaalrekening']); assert.match(row[0], /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(t.rows.some(r => r[4] === 'Overboeking'));          // payee met transfer_acct
  assert.ok(t.rows.some(r => r[6] === 'handmatige notitie'));
  assert.ok(t.rows.some(r => r[4] === ''));                      // ongecategoriseerd blijft leeg
  assert.equal(t.categoryMeta.Salary.income, true); assert.equal(t.categoryMeta.Rent.group, 'Usual Expenses');
});

test('Actual: plan is een voorbeeld (schrijft niets) en vat samen', () => {
  const db = openDb(':memory:'), [t] = loadTables(actualZip());
  const p = buildPlan(db, t, cfgOf(t));
  assert.equal(p.summary.valid, 622); assert.equal(p.summary.errors, 0); assert.equal(p.summary.added, 622); assert.equal(p.summary.newAccounts, 1);
  assert.deepEqual(p.accountPlan.map(a => [a.value, a.count, a.action.type]), [['Betaalrekening', 622, 'new']]);
  const rent = p.categoryPlan.find(c => c.value === 'Rent'); assert.equal(rent.action.type, 'existing'); assert.equal(rent.action.name, 'Huur / hypotheek');   // synoniem
  const fp = p.categoryPlan.find(c => c.value === 'Fuel & Parking'); assert.equal(fp.action.type, 'new'); assert.equal(fp.action.grp, 'Usual Expenses'); assert.equal(fp.action.kind, 'expense');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, 0);
});

test('Actual: import maakt rekening/categorieën (met groep), leert, is idempotent en terug te draaien', () => {
  const db = openDb(':memory:'), [t] = loadTables(actualZip()), cfg = cfgOf(t);
  const r = applyPlan(db, buildPlan(db, t, cfg), { name: 'My Finances' });
  assert.equal(r.added, 622); assert.ok(r.learned > 400); assert.ok(r.createdCategories >= 3);
  assert.equal(db.prepare("SELECT grp FROM categories WHERE name='Fuel & Parking'").get().grp, 'Usual Expenses');
  assert.equal(db.prepare("SELECT iban FROM accounts").get().iban, 'ACTUAL-betaalrekening');
  const w = db.prepare("SELECT c.name cat, t.confirmed f, t.cat_source s FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.payee='Woonbron' LIMIT 1").get();
  assert.deepEqual({ ...w }, { cat: 'Huur / hypotheek', f: 1, s: 'manual' });
  const again = applyPlan(db, buildPlan(db, t, cfg), { name: 'My Finances' });
  assert.equal(again.added, 0); assert.equal(again.skipped, 622); assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, 622);
});

test('Actual: rekeningkoppeling (bestaande rekening of nieuwe met echt IBAN) en standaardrekening', () => {
  const [t] = loadTables(actualZip()), cfg = cfgOf(t);
  const db = openDb(':memory:'); importTransactions(db, parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8')));
  const existing = db.prepare('SELECT id FROM accounts').get().id;
  const p1 = buildPlan(db, t, { ...cfg, accountMap: { Betaalrekening: { type: 'existing', id: existing } } });
  assert.equal(p1.accountPlan[0].action.type, 'existing'); assert.equal(p1.summary.newAccounts, 0);
  const db2 = openDb(':memory:');
  const p2 = buildPlan(db2, t, { ...cfg, accountMap: { Betaalrekening: { type: 'new', name: 'Mijn betaalrekening', iban: 'nl12 rabo 0123 4567 89' } } });
  applyPlan(db2, p2, { name: 'x' });
  assert.deepEqual({ ...db2.prepare('SELECT iban, name FROM accounts').get() }, { iban: 'NL12RABO0123456789', name: 'Mijn betaalrekening' });
});

test('verrijken: een Actual-export na de Rabobank-import geeft de bestaande transacties je categorie (geen dubbelen)', () => {
  const db = openDb(':memory:'); importTransactions(db, demoTxs());
  const before = db.prepare('SELECT COUNT(*) c FROM transactions').get().c, [t] = loadTables(actualZip());
  const existing = db.prepare('SELECT id FROM accounts').get().id;
  const plan = buildPlan(db, t, { ...cfgOf(t), accountMap: { Betaalrekening: { type: 'existing', id: existing } } });
  assert.ok(plan.summary.enrich >= 600); assert.ok(plan.summary.added < 5);
  const r = applyPlan(db, plan, { name: 'My Finances' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, before + r.added);
  const v = db.prepare("SELECT c.name n, t.confirmed f FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.merchant='woonbron' LIMIT 1").get();
  assert.deepEqual({ ...v }, { n: 'Huur / hypotheek', f: 1 });
});

test('Rabobank-CSV na een Actual-import sluit aan op dezelfde transacties (zelfde IBAN, datum, bedrag), categorie blijft', () => {
  const db = openDb(':memory:'), [t] = loadTables(actualZip());
  applyPlan(db, buildPlan(db, t, { ...cfgOf(t), accountMap: { Betaalrekening: { type: 'new', name: 'Betaal', iban: 'NL12RABO0123456789' } } }), { name: 'x' });
  const n = db.prepare('SELECT COUNT(*) c FROM transactions').get().c, cat = db.prepare("SELECT category_id FROM transactions WHERE merchant='woonbron' LIMIT 1").get().category_id;
  const r = importTransactions(db, demoTxs(), { name: 'rabo.csv' });
  assert.ok(r.adopted >= 600, `adopted=${r.adopted}`); assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, n + r.added);
  const row = db.prepare("SELECT category_id, confirmed, seq, balance, key FROM transactions WHERE merchant='woonbron' LIMIT 1").get();
  assert.equal(row.category_id, cat); assert.equal(row.confirmed, 1); assert.ok(row.seq > 0); assert.ok(row.balance != null); assert.ok(!row.key.startsWith('actual|'));
  assert.equal(importTransactions(db, demoTxs(), { name: 'rabo.csv' }).added, 0);        // opnieuw importeren: niets nieuws
});

test('budgetten uit Actual (tracking en envelope): nieuwe categorieën worden aangemaakt', () => {
  for (const budgetType of ['tracking', 'envelope']) {
    const db = openDb(':memory:'), tables = loadTables(actualZip({ budgetType })), t = tables.find(x => x.name === 'Budgetten'), g = guessMapping(t);
    assert.equal(g.kind, 'budgets'); assert.equal(t.rows.length, 8);
    const plan = buildBudgetPlan(db, t, { fields: g.fields, budget: g.budget, decimal: g.decimal });
    assert.equal(plan.summary.valid, 8); assert.equal(plan.summary.newCategories, 3);       // Groceries→bestaand, 'Gardening' e.d. nieuw
    const r = applyBudgetPlan(db, plan); assert.equal(r.budgets, 8); assert.equal(r.createdCategories, 3);
    const b = db.prepare("SELECT month, amount FROM budgets WHERE category_id=(SELECT id FROM categories WHERE key='groceries') ORDER BY month").all().map(x => ({ ...x }));
    assert.deepEqual(b, [{ month: '2026-10', amount: 45000 }, { month: '2026-11', amount: 45000 }]);
  }
});

test('Actual: tabel zonder datum geeft een duidelijke fout', () => {
  const db = openDb(':memory:'), [t] = loadTables(actualZip());
  assert.throws(() => buildPlan(db, t, { fields: { amount: 'Bedrag' } }), /datum/);
});

test('API: analyseren → voorbeeld → importeren van een Actual-export; fouten zijn 400', async () => {
  const db = openDb(':memory:'), api = createApi(db), body = { base64: actualZip().toString('base64'), name: 'My Finances.zip' };
  const a = await api('POST', '/api/actual/analyze', body);
  assert.deepEqual(a.tables.map(x => [x.name, x.guess.kind]), [['Transacties', 'transactions'], ['Budgetten', 'budgets']]);
  const tx = a.tables[0], cfg = { fields: tx.guess.fields, decimal: tx.guess.decimal, dateOrder: tx.guess.dateOrder, sign: 'as-is' };
  const p = await api('POST', '/api/actual/plan', { ...body, table: 'Transacties', kind: 'transactions', config: cfg });
  assert.equal(p.summary.valid, 622); assert.equal(p.accountPlan.length, 1); assert.ok(p.categoryPlan.length > 10);
  const r = await api('POST', '/api/actual/import', { ...body, table: 'Transacties', kind: 'transactions', config: cfg }); assert.equal(r.added, 622);
  const bu = a.tables[1], rb = await api('POST', '/api/actual/import', { ...body, table: 'Budgetten', kind: 'budgets', config: { fields: bu.guess.fields, budget: bu.guess.budget, decimal: bu.guess.decimal } });
  assert.equal(rb.budgets, 8);
  assert.ok((await api('GET', '/api/dashboard?month=2026-10')).totals.expenses > 0);
  assert.equal(await status(api('POST', '/api/actual/plan', { ...body, table: 'Bestaat niet', kind: 'transactions', config: {} })), 400);
  assert.equal(await status(api('POST', '/api/actual/plan', { ...body, table: 'Transacties', kind: 'transactions', config: { fields: { amount: 'Bedrag' } } })), 400);
  assert.equal(await status(api('POST', '/api/actual/analyze', { base64: Buffer.from('geen zip').toString('base64') })), 400);
  assert.equal(await status(api('POST', '/api/actual/analyze', {})), 400);
  // een Actual-export op de Rabobank-importroute: duidelijke verwijzing naar de juiste importer
  await assert.rejects(() => api('POST', '/api/import', { base64: body.base64, name: 'My Finances.zip' }), /Actual Budget/);
});

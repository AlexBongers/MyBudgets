import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { readZip } from '../src/zip.js';
import { loadTables, guessMapping, parseLooseDate, parseLooseMoney, detectDecimalSep, detectDateOrder, matchCategory, buildPlan, applyPlan, buildBudgetPlan, applyBudgetPlan } from '../src/notion.js';
import { openDb, importTransactions, DEFAULT_CATEGORIES } from '../src/db.js';
import { parseRabobank } from '../src/rabobank.js';
import { createApi } from '../src/service.js';

// --- kleine ZIP-schrijver voor tests (methode 0 of 8)
const crc32 = (() => { const t = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; }); return b => { let c = -1; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }; })();
function makeZip(files, deflate = true) {
  const parts = [], central = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content), nb = Buffer.from(name), comp = deflate ? deflateRawSync(data) : data, crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, eocd]);
}
const csv = rows => rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');

const NL = csv([
  ['Naam', 'Datum', 'Bedrag', 'Categorie', 'Type', 'Notities', 'Created time'],
  ['Albert Heijn', '12 november 2026', '€54,22', 'Boodschappen', 'Uitgave', 'weekboodschappen', 'November 12, 2026 9:41 AM'],
  ['Netflix', '5 november 2026', '€13,99', 'Abonnementen', 'Uitgave', '', 'November 5, 2026 8:00 AM'],
  ['Salaris Acme', '25 oktober 2026', '€3.150,00', 'Salaris', 'Inkomsten', '', 'October 25, 2026 8:00 AM'],
  ['Kruidvat', '3 november 2026 → 4 november 2026', '€1.234,56', 'Drogisterij', 'Uitgave', '', ''],
  ['Mevrouw Jansen', '01-11-2026', '€40,00', 'Huisdieren (https://www.notion.so/Huisdieren-0123456789abcdef0123456789abcdef)', 'Uitgave', '', ''],
  ['Kapotte rij', 'ooit', 'veel', 'x', 'Uitgave', '', ''],
]);

test('datums: NL, EN, ISO, bereiken, tijd, dubbelzinnig', () => {
  assert.equal(parseLooseDate('12 november 2026'), '2026-11-12');
  assert.equal(parseLooseDate('November 12, 2026'), '2026-11-12');
  assert.equal(parseLooseDate('Nov 5, 2026 2:30 PM'), '2026-11-05');
  assert.equal(parseLooseDate('@March 3, 2026 → March 9, 2026'), '2026-03-03');
  assert.equal(parseLooseDate('3 mrt 2026'), '2026-03-03');
  assert.equal(parseLooseDate('2026-11-12T09:00:00.000Z'), '2026-11-12');
  assert.equal(parseLooseDate('2026/11/12'), '2026-11-12');
  assert.equal(parseLooseDate('03/04/2026'), '2026-04-03');
  assert.equal(parseLooseDate('03/04/2026', 'mdy'), '2026-03-04');
  assert.equal(parseLooseDate('31-02-2026'), null);
  assert.equal(parseLooseDate('ooit'), null);
  assert.equal(detectDateOrder(['03/25/2026', '01/02/2026']), 'mdy');
  assert.equal(detectDateOrder(['25/03/2026']), 'dmy');
});

test('bedragen: NL/EN notatie, valuta, min, haakjes, spaties', () => {
  assert.equal(parseLooseMoney('€1.234,56', ','), 123456);
  assert.equal(parseLooseMoney('-€1,234.50', '.'), -123450);
  assert.equal(parseLooseMoney('€ -12,5'), -1250);
  assert.equal(parseLooseMoney('(12,00)'), -1200);
  assert.equal(parseLooseMoney('12,00-'), -1200);
  assert.equal(parseLooseMoney('−45,10'), -4510);
  assert.equal(parseLooseMoney('1 234,50 EUR'), 123450);
  assert.equal(parseLooseMoney('12.5', '.'), 1250);
  assert.equal(parseLooseMoney('1.234', ','), 123400);   // Nederlands: duizendtal
  assert.equal(parseLooseMoney('abc'), null);
  assert.equal(parseLooseMoney(''), null);
  assert.equal(detectDecimalSep(['€1,234.50', '€12.00', '€3.5']), '.');
  assert.equal(detectDecimalSep(['€1.234,50', '€12,00']), ',');
});

test('ZIP: deflate + opgeslagen, geneste mappen, __MACOSX wordt genegeerd', () => {
  for (const deflate of [true, false]) {
    const z = readZip(makeZip({ 'Export/a.csv': 'x,y\n1,2', 'Export/Sub/b.md': '# hoi', '__MACOSX/._a.csv': 'junk' }, deflate));
    assert.deepEqual(z.map(e => e.name).sort(), ['Export/Sub/b.md', 'Export/a.csv']);
    assert.equal(z.find(e => e.name.endsWith('a.csv')).data.toString(), 'x,y\n1,2');
  }
  assert.throws(() => readZip(Buffer.from('PK\x03\x04 niet echt')), /ZIP/);
});

test('Notion-ZIP: Notion-id in naam, _all-variant wint, md-bestanden en geneste zip', () => {
  const inner = makeZip({ 'Part/Budget 0123456789abcdef0123456789abcdef.csv': NL });
  const zip = makeZip({ 'Export-abc/Budget 0123456789abcdef0123456789abcdef.csv': NL.split('\n').slice(0, 3).join('\n'), 'Export-abc/Budget 0123456789abcdef0123456789abcdef_all.csv': NL,
    'Export-abc/Budget/Pagina.md': '# x', 'Export-abc/Part-1.zip': inner, 'Export-abc/Leeg abc.csv': 'Naam' });
  const t = loadTables(zip, 'export.zip');
  assert.equal(t.length, 1); assert.equal(t[0].name, 'Budget'); assert.equal(t[0].rows.length, 6);
  assert.throws(() => loadTables(makeZip({ 'a.md': 'x' }), 'x.zip'), /geen CSV/);
});

test('kolomherkenning op een Nederlandse Notion-tabel', () => {
  const t = loadTables(Buffer.from(NL), 'Uitgaven.csv')[0], g = guessMapping(t);
  assert.equal(g.kind, 'transactions');
  assert.deepEqual({ date: g.fields.date, amount: g.fields.amount, payee: g.fields.payee, category: g.fields.category, type: g.fields.type, notes: g.fields.notes },
    { date: 'Datum', amount: 'Bedrag', payee: 'Naam', category: 'Categorie', type: 'Type', notes: 'Notities' });
  assert.equal(g.decimal, ',');
});

test('kolomherkenning: Engelse tabel, aparte in/uit-kolommen en onbekende kolomnamen op waarden', () => {
  const en = loadTables(Buffer.from(csv([['Name', 'Date', 'Amount', 'Category'], ['Shell', 'November 12, 2026', '-$65.40', 'Fuel'], ['Pay', 'November 25, 2026', '€3,150.00', 'Salary'], ['Lidl', 'Nov 3, 2026', '-€1,234.50', 'Food']])), 'Money.csv')[0];
  const g = guessMapping(en); assert.equal(g.fields.date, 'Date'); assert.equal(g.fields.amount, 'Amount'); assert.equal(g.decimal, '.');
  const split = loadTables(Buffer.from(csv([['Wat', 'Wanneer', 'Uitgaven', 'Inkomsten'], ['Huur', '01-11-2026', '1050', ''], ['Salaris', '25-10-2026', '', '3150'], ['Bakker', '02-11-2026', '4,5', '']])), 'x.csv')[0];
  const g2 = guessMapping(split); assert.equal(g2.fields.amountOut, 'Uitgaven'); assert.equal(g2.fields.amountIn, 'Inkomsten'); assert.equal(g2.fields.date, 'Wanneer');
  const odd = loadTables(Buffer.from(csv([['Ding', 'Zus', 'Zo'], ['A', '2026-01-05', '12,50'], ['B', '2026-01-06', '7,25'], ['C', '2026-01-07', '3,00']])), 'x.csv')[0];
  const g3 = guessMapping(odd); assert.equal(g3.fields.date, 'Zus'); assert.equal(g3.fields.amount, 'Zo'); assert.equal(g3.fields.payee, 'Ding');
});

const cats = DEFAULT_CATEGORIES.map((c, i) => ({ id: i + 1, key: c[0], name: c[1], kind: c[2] }));
test('categorie-koppeling via naam en synoniemen', () => {
  const id = v => matchCategory(v, cats)?.key;
  assert.equal(id('Boodschappen'), 'groceries'); assert.equal(id('Supermarkt'), 'groceries'); assert.equal(id('uit eten'), 'dining');
  assert.equal(id('Zorgverzekering'), 'healthins'); assert.equal(id('Benzine'), 'fuel'); assert.equal(id('Vakantie'), 'travel'); assert.equal(id('Salaris'), 'salary');
  assert.equal(id('Kerst-cadeaus'), 'gifts'); assert.equal(id('Iets raars'), undefined);
});

test('plan: tekens uit Type, bedragen, bereiken, relaties, fouten; schrijft niets', () => {
  const db = openDb(':memory:'), t = loadTables(Buffer.from(NL), 'U.csv')[0], g = guessMapping(t);
  const plan = buildPlan(db, t, { fields: g.fields, decimal: g.decimal, dateOrder: g.dateOrder, sign: 'auto' });
  assert.equal(plan.summary.valid, 5); assert.equal(plan.summary.errors, 1); assert.equal(plan.errors[0].row, 7);
  const by = n => plan.rows.find(r => r.payee === n);
  assert.equal(by('Albert Heijn').amount, -5422); assert.equal(by('Salaris Acme').amount, 315000); assert.equal(by('Kruidvat').amount, -123456);
  assert.equal(by('Kruidvat').date, '2026-11-03'); assert.equal(by('Mevrouw Jansen').category, 'Huisdieren');
  assert.equal(plan.categoryPlan.find(c => c.value === 'Boodschappen').action.name, 'Boodschappen');
  assert.equal(plan.categoryPlan.find(c => c.value === 'Drogisterij').action.name, 'Drogist & verzorging'); // via synoniem
  assert.equal(plan.categoryPlan.find(c => c.value === 'Huisdieren').action.type, 'new');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, 0);
});

test('import: nieuwe transacties, categorieën aangemaakt, geleerd, ongewijzigd opnieuw importeren = niets nieuws', () => {
  const db = openDb(':memory:'), t = loadTables(Buffer.from(NL), 'U.csv')[0], g = guessMapping(t);
  const cfg = { fields: g.fields, decimal: g.decimal, dateOrder: g.dateOrder, sign: 'auto' };
  const r = applyPlan(db, buildPlan(db, t, cfg), { name: 'U.csv' });
  assert.equal(r.added, 5); assert.equal(r.learned, 5); assert.equal(r.createdCategories, 1);
  const row = db.prepare("SELECT t.cat_source, t.confirmed, c.name cat FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.payee='Albert Heijn'").get();
  assert.deepEqual({ ...row }, { cat_source: 'manual', confirmed: 1, cat: 'Boodschappen' });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM categories WHERE name='Huisdieren'").get().c, 1);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM memory').get().c >= 5);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM imports').get().c, 1);
  const again = applyPlan(db, buildPlan(db, t, cfg), { name: 'U.csv' });
  assert.equal(again.added, 0); assert.equal(again.skipped, 5); assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, 5);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM imports').get().c, 1);
});

test('verrijken: bestaande Rabobank-transacties krijgen de Notion-categorie (en de app leert ervan)', () => {
  const db = openDb(':memory:');
  importTransactions(db, parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8')));
  const before = db.prepare('SELECT COUNT(*) c FROM transactions').get().c;
  const dier = db.prepare("SELECT date, amount FROM transactions WHERE merchant='dierenspeciaalzaak kat' ORDER BY date DESC LIMIT 2").all();
  const notion = csv([['Winkel', 'Datum', 'Bedrag', 'Categorie'],
    ['Dierenwinkel', dier[0].date, (dier[0].amount / 100).toFixed(2).replace('.', ','), 'Huisdieren'],
    ['Dierenwinkel', shift(dier[1].date, 1), (dier[1].amount / 100).toFixed(2).replace('.', ','), 'Huisdieren'],   // dag later geboekt
    ['Onbekende nieuwe winkel', '2026-11-10', '-12,00', 'Overig']]);
  const t = loadTables(Buffer.from(notion), 'x.csv')[0], g = guessMapping(t);
  const plan = buildPlan(db, t, { fields: g.fields, decimal: g.decimal, dateOrder: g.dateOrder, sign: 'auto' });
  assert.equal(plan.summary.enrich, 2); assert.equal(plan.summary.added, 1);
  const r = applyPlan(db, plan, { name: 'x.csv' });
  assert.equal(r.enriched, 2); assert.equal(r.added, 1); assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions').get().c, before + 1);
  const cat = db.prepare("SELECT c.name n, t.confirmed f FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.merchant='dierenspeciaalzaak kat' AND t.date=?").get(dier[0].date);
  assert.deepEqual({ ...cat }, { n: 'Huisdieren', f: 1 });
  // de rest van de dierenwinkel-transacties is nu door het geheugen ingedeeld
  const rest = db.prepare("SELECT COUNT(*) c FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.merchant='dierenspeciaalzaak kat' AND c.name='Huisdieren'").get().c;
  assert.ok(rest >= 5, `verwacht ≥5 ingedeeld, kreeg ${rest}`);
});
const shift = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10);

test('rekening-kolom: IBAN en namen; zonder kolom de gekozen standaardrekening', () => {
  const db = openDb(':memory:');
  const t = loadTables(Buffer.from(csv([['Naam', 'Datum', 'Bedrag', 'Rekening'], ['A', '2026-01-05', '-5,00', 'NL12 RABO 0123 4567 89'], ['B', '2026-01-06', '-6,00', 'Spaarpot Vakantie']])), 'x.csv')[0];
  const g = guessMapping(t); assert.equal(g.fields.account, 'Rekening');
  const r = applyPlan(db, buildPlan(db, t, { fields: g.fields, sign: 'as-is' }), { name: 'x' });
  assert.equal(r.added, 2);
  const accs = db.prepare('SELECT iban, name FROM accounts ORDER BY id').all().map(a => ({ ...a }));
  assert.deepEqual(accs.map(a => a.iban), ['NL12RABO0123456789', 'NOTION-spaarpot-vakantie']);
  // standaardrekening
  const db2 = openDb(':memory:'); importTransactions(db2, parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8')));
  const accId = db2.prepare('SELECT id FROM accounts').get().id;
  const t2 = loadTables(Buffer.from(csv([['Naam', 'Datum', 'Bedrag'], ['Nieuw', '2026-11-11', '-3,00']])), 'y.csv')[0], g2 = guessMapping(t2);
  applyPlan(db2, buildPlan(db2, t2, { fields: g2.fields, sign: 'as-is', defaultAccount: accId }), { name: 'y' });
  assert.equal(db2.prepare("SELECT account_id FROM transactions WHERE payee='Nieuw'").get().account_id, accId);
});

test('budgetten: categorie + bedrag (+ maand), onbekende categorieën blijven over', () => {
  const db = openDb(':memory:');
  const t = loadTables(Buffer.from(csv([['Categorie', 'Budget', 'Maand'], ['Boodschappen', '€450,00', '2026-10'], ['Boodschappen', '€475,00', 'November 1, 2026'], ['Huur', '1050', ''], ['Zwevende kaboutermannetjes', '10', '']])), 'Budgetten.csv')[0];
  const g = guessMapping(t); assert.equal(g.kind, 'budgets'); assert.equal(g.budget.amount, 'Budget'); assert.equal(g.budget.month, 'Maand');
  const plan = buildBudgetPlan(db, t, { fields: g.fields, budget: g.budget, decimal: g.decimal });
  assert.equal(plan.summary.valid, 3); assert.equal(plan.summary.unmatched, 1);
  const r = applyBudgetPlan(db, plan); assert.equal(r.budgets, 3);
  const b = db.prepare("SELECT month, amount FROM budgets WHERE category_id=(SELECT id FROM categories WHERE key='groceries') ORDER BY month").all().map(x => ({ ...x }));
  assert.deepEqual(b, [{ month: '2026-10', amount: 45000 }, { month: '2026-11', amount: 47500 }]);
  assert.equal(db.prepare("SELECT month FROM budgets WHERE category_id=(SELECT id FROM categories WHERE key='rent')").get().month, '2000-01');
});

test('API: analyze → plan → import via service, met ZIP', async () => {
  const db = openDb(':memory:'), api = createApi(db);
  const zip = makeZip({ 'Export/Uitgaven 0123456789abcdef0123456789abcdef_all.csv': NL, 'Export/Budgetten 11111111111111111111111111111111.csv': csv([['Categorie', 'Budget'], ['Boodschappen', '450'], ['Abonnementen', '30']]) });
  const body = { base64: zip.toString('base64'), name: 'Export.zip' };
  const a = await api('POST', '/api/notion/analyze', body);
  assert.deepEqual(a.tables.map(t => [t.name, t.guess.kind]).sort(), [['Budgetten', 'budgets'], ['Uitgaven', 'transactions']]);
  const tx = a.tables.find(t => t.name === 'Uitgaven');
  const cfg = { fields: tx.guess.fields, decimal: tx.guess.decimal, dateOrder: tx.guess.dateOrder, sign: 'auto' };
  const p = await api('POST', '/api/notion/plan', { ...body, table: 'Uitgaven', kind: 'transactions', config: cfg });
  assert.equal(p.summary.added, 5); assert.equal(p.preview.length, 5);
  const imp = await api('POST', '/api/notion/import', { ...body, table: 'Uitgaven', kind: 'transactions', config: cfg });
  assert.equal(imp.added, 5);
  const bu = a.tables.find(t => t.name === 'Budgetten');
  const ib = await api('POST', '/api/notion/import', { ...body, table: 'Budgetten', kind: 'budgets', config: { fields: bu.guess.fields, budget: bu.guess.budget, decimal: bu.guess.decimal } });
  assert.equal(ib.budgets, 2);
  const dash = await api('GET', '/api/dashboard?month=2026-11'); assert.ok(dash.totals.expenses > 0);
  await assert.rejects(() => api('POST', '/api/notion/plan', { ...body, table: 'Bestaat niet', kind: 'transactions', config: {} }), /Tabel niet gevonden/);
  await assert.rejects(() => api('POST', '/api/notion/plan', { ...body, table: 'Uitgaven', kind: 'transactions', config: { fields: { amount: 'Bedrag' } } }), /datum/);
  await assert.rejects(() => api('POST', '/api/notion/analyze', { base64: Buffer.from('PK\x03\x04kapot').toString('base64') }), /ZIP/);
});

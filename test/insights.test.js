import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, importTransactions } from '../src/db.js';
import { parseRabobank } from '../src/rabobank.js';
import { createApi } from '../src/service.js';
import { computeInsights, niceName } from '../src/insights.js';

const hdr = '"IBAN/BBAN","Munt","Volgnr","Datum","Bedrag","Naam tegenpartij","Omschrijving-1"';
const mk = rows => { const db = openDb(':memory:'); importTransactions(db, parseRabobank([hdr, ...rows.map(([d, a, n], i) => `"NL01RABO0000000001","EUR","${i + 1}","${d}","${a}","${n}","x"`)].join('\n'))); return db; };
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

test('inzichten: te weinig gegevens geeft een nette melding', () => {
  assert.equal(computeInsights(openDb(':memory:')).enough, false);
  assert.equal(computeInsights(mk([['2026-01-10', '-10,00', 'Jumbo']])).enough, false);
});

test('inzichten op voorbeelddata: bevindingen met alle velden, via de API en uit de cache', async () => {
  const db = openDb(':memory:'); importTransactions(db, parseRabobank(readFileSync(new URL('../samples/rabobank-demo.csv', import.meta.url), 'utf8')));
  const api = createApi(db), d = await api('GET', '/api/insights');
  assert.equal(d.enough, true); assert.equal(d.period.months, 14); assert.equal(d.period.to, '2026-10');     // november is nog niet compleet
  assert.ok(d.findings.length >= 5);
  for (const f of d.findings) { assert.ok(f.title && f.text && f.value && f.kicker && f.section, f.id); assert.match(f.tone, /^(good|warn|info)$/); assert.ok(!('impact' in f)); }
  assert.equal(d.season.length, 12); assert.equal(d.weekdays.length, 7); assert.equal(d.weekdays[0].day, 'ma');
  assert.equal(d.monthly.reduce((a, m) => a + m.income, 0), d.years.reduce((a, y) => a + y.income, 0));
  assert.equal(d.shifts.length, 0);                                         // minder dan 24 maanden: geen eerlijke vergelijking
  assert.ok(d.cash.n > 0 && d.merchants[0].name === 'Albert Heijn');
  assert.equal(await api('GET', '/api/insights'), d);                       // zelfde object: cache
  await api('POST', '/api/categories', { name: 'Nieuw' }); assert.notEqual(await api('GET', '/api/insights'), d);
});

test('inzichten: seizoensmaand, contant, achteraf betalen, gestopte en duurdere vaste last, schrijfwijzen samengevoegd', () => {
  const rows = [];
  for (let i = 0; i < 26; i++) {
    const y = 2024 + Math.floor(i / 12), m = i % 12 + 1, mo = ym(y, m);
    rows.push([`${mo}-25`, m === 5 ? '6000,00' : '3000,00', 'Werkgever BV']);
    rows.push([`${mo}-01`, '-900,00', 'Woonbron']);
    rows.push([`${mo}-03`, i < 13 ? '-40,00' : '-55,00', 'Netflix International']);                 // duurder geworden
    if (i < 16) rows.push([`${mo}-05`, '-400,00', 'Kinderopvang De Boom']);                          // gestopt
    rows.push([`${mo}-08`, '-60,00', i < 12 ? 'Jumbo Odijk Odijk' : 'BCK*Jumbo Odijk']);             // zelfde winkel, andere schrijfwijze
    rows.push([`${mo}-15`, '-55,00', i < 12 ? 'Jumbo Odijk Odijk' : 'BCK*Jumbo Odijk']);
    rows.push([`${mo}-12`, '-100,00', 'Geldmaat Hoofdstraat']);
    if (i >= 14) rows.push([`${mo}-18`, '-80,00', 'Klarna Bank AB']);
  }
  rows.push(['2025-06-20', '-4000,00', 'Autobedrijf Jansen']);
  const d = computeInsights(mk(rows)), ids = d.findings.map(f => f.id);
  assert.equal(d.period.months, 26); assert.equal(d.period.hasPrev, true);
  assert.deepEqual(d.bonusMonths, [5]); assert.ok(ids.includes('season'));
  assert.equal(d.cash.total, 26 * 10000); assert.ok(ids.includes('cash'));
  assert.equal(d.bnpl.n, 12); assert.ok(ids.includes('bnpl'));
  assert.equal(d.oneOffs.list.length, 1); assert.equal(d.oneOffs.list[0].payee, 'Autobedrijf Jansen'); assert.equal(d.oneOffs.list[0].amount, 400000);
  assert.ok(d.fixed.ended.some(e => /Kinderopvang/.test(e.name) && e.monthly > 10000), 'gestopte vaste last');
  const nf = d.fixed.creep.find(c => /Netflix/.test(c.name)); assert.ok(nf); assert.equal(nf.from, 4000); assert.equal(nf.to, 5500); assert.equal(nf.yearly, 18000);
  const jumbo = d.merchants.filter(m => /Jumbo/.test(m.name)); assert.equal(jumbo.length, 1); assert.equal(jumbo[0].n, 24);      // 12 maanden × 2, beide schrijfwijzen samen
  assert.ok(d.findings[0].title);                                           // gesorteerd op belang
});

test('niceName: leesbare namen', () => {
  assert.equal(niceName('BCK*Jumbo Odijk'), 'Jumbo Odijk'); assert.equal(niceName('Jumbo Odijk Odijk'), 'Jumbo Odijk');
  assert.equal(niceName('AmazonRetail www.amazon.nlLUX'), 'Amazon'); assert.equal(niceName('Klarna Bank Ab via Mollie'), 'Klarna Bank Ab');
});

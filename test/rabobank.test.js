// Tests voor de Rabobank-parser. Grotendeels overgenomen uit AlexBongers/actual-budget-mcp (tests/rabobank.test.ts),
// aangepast aan de uitvoerstructuur en Nederlandse meldingen van deze app.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRabobankCsv, parseAmount, parseDate } from '../src/rabobank.js';
import { openDb } from '../src/db.js';
import { createApi } from '../src/service.js';

const iban = 'NL00RABO0000000001';
const fullHeaders = ['IBAN/BBAN', 'Munt', 'BIC', 'Volgnr', 'Datum', 'Rentedatum', 'Bedrag', 'Saldo na trn', 'Tegenrekening IBAN/BBAN',
  'Naam tegenpartij', 'Naam uiteindelijke partij', 'Naam initiërende partij', 'BIC tegenpartij', 'Code', 'Batch ID', 'Transactiereferentie',
  'Machtigingskenmerk', 'Incassant ID', 'Betalingskenmerk', 'Omschrijving-1', 'Omschrijving-2', 'Omschrijving-3', 'Reden retour',
  'Oorspr bedrag', 'Oorspr munt', 'Koers'];
const csvLine = (values, sep = ',') => values.map(v => `"${v.replaceAll('"', '""')}"`).join(sep);
const fullRow = values => { const r = Array(fullHeaders.length).fill(''); for (const [i, v] of Object.entries(values)) r[Number(i)] = v; return r; };
const csvWithRowAtLine = (line, row) => {
  const lines = [csvLine(['IBAN/BBAN', 'Datum', 'Bedrag', 'Naam tegenpartij', 'Omschrijving-1'])];
  while (lines.length < line - 1) lines.push('');
  lines.push(row); return lines.join('\n');
};

test('parseert het actuele geciteerde Rabobank-formaat met UTF-8 BOM, saldo en volgnummer', () => {
  const csv = [`﻿${csvLine(fullHeaders)}`,
    csvLine(fullRow({ 0: iban, 1: 'EUR', 3: '1', 4: '2026-08-01', 6: '-12,34', 7: '987,66', 8: 'NL00RABO0000000002', 9: 'Cafe De Hoek', 13: 'BA', 15: 'REF-1', 19: 'Lunch, "met bon"' })),
    csvLine(fullRow({ 0: iban, 1: 'EUR', 3: '2', 4: '2026-08-02', 6: '+99,01', 9: 'Werkgever', 19: 'Salaris' }))].join('\n');
  const r = parseRabobankCsv(csv);
  assert.equal(r.detection.isRabobank, true); assert.equal(r.detection.separator, ','); assert.equal(r.detection.encoding, 'utf8-bom');
  assert.equal(r.rowsInFile, 2); assert.equal(r.transactions.length, 2);
  const t = r.transactions[0].tx;
  assert.equal(t.amount, -1234); assert.equal(t.balance, 98766); assert.equal(t.seq, 1); assert.equal(t.code, 'ba');
  assert.equal(t.description, 'Lunch, "met bon"'); assert.equal(t.payee, 'Cafe De Hoek'); assert.equal(t.date, '2026-08-01');
  assert.equal(t.counter_iban, 'NL00RABO0000000002'); assert.equal(t.key, `${iban}|1|2026-08-01|-1234`);
});

test('herkent puntkomma, oude datums en Europese bedragen', () => {
  const headers = ['IBAN/BBAN', 'Munt', 'Volgnr', 'Datum', 'Bedrag', 'Tegenrekening IBAN/BBAN', 'Naam tegenpartij', 'Omschrijving-1'];
  const row = [iban, 'EUR', '9', '01-08-2026', '1.234,56', 'NL00RABO0000000003', 'Leverancier', 'Factuur'];
  const r = parseRabobankCsv([csvLine(headers, ';'), csvLine(row, ';')].join('\n'));
  assert.equal(r.detection.separator, ';'); assert.equal(r.transactions[0].tx.amount, 123456); assert.equal(r.transactions[0].tx.date, '2026-08-01');
});

test('herkent het scheidingsteken na lege regels bovenaan; regelnummers kloppen', () => {
  const r = parseRabobankCsv(['', '', csvLine(['IBAN/BBAN', 'Datum', 'Bedrag'], ';'), csvLine([iban, '2026-08-01', '1,00'], ';')].join('\n'));
  assert.equal(r.detection.separator, ';'); assert.equal(r.transactions[0].row, 4);
});

test('repareert een niet-gesloten geciteerd veld zonder de rest van het bestand op te slokken', () => {
  const csv = [csvLine(['IBAN/BBAN', 'Datum', 'Bedrag', 'Naam tegenpartij', 'Omschrijving-1']),
    csvLine([iban, '2026-08-01', '-12,34', 'Winkel', 'Lunch']).replace(/"Lunch"$/, '"Lunch'),
    csvLine([iban, '2026-08-02', '+5,00', 'Werk', 'Terugbetaling'])].join('\n');
  const r = parseRabobankCsv(csv);
  assert.equal(r.transactions.length, 2); assert.equal(r.transactions[0].tx.description, 'Lunch');
  assert.ok(r.detection.warnings.some(w => w.includes('regeleinde')));
});

test('repareert het defecte embedded-quote-patroon (regel 4400)', () => {
  const r = parseRabobankCsv(csvWithRowAtLine(4400, `"${iban}","2026-08-01","-12,34","Winkel "Vestiging" Plaats","Omschrijving"`));
  assert.equal(r.transactions.length, 1); assert.equal(r.transactions[0].tx.payee, 'Winkel "Vestiging" Plaats');
  assert.ok(r.detection.warnings.some(w => w.startsWith('Regel 4400:') && w.includes('los aanhalingsteken')));
});

test('repareert het defecte end-of-field-quote-patroon (regel 7903)', () => {
  const r = parseRabobankCsv(csvWithRowAtLine(7903, `"${iban}","2026-08-02","-99,95","Winkel "Vestiging"","Omschrijving"`));
  assert.equal(r.transactions.length, 1); assert.equal(r.transactions[0].tx.payee, 'Winkel "Vestiging"');
  assert.ok(r.detection.warnings.some(w => w.startsWith('Regel 7903:') && w.includes('dubbele aanhalingsteken')));
});

test('wijst rijen af waarvan het aantal kolommen niet klopt met de kop', () => {
  const r = parseRabobankCsv(csvWithRowAtLine(37, csvLine([iban, '2026-08-01', '-1,00', 'Ontbrekende omschrijving'])));
  assert.equal(r.transactions.length, 0);
  assert.deepEqual(r.skippedRows, [{ row: 37, reason: 'Aantal kolommen klopt niet: verwacht 5, gevonden 4.' }]);
});

test('ontdubbelt herhaalde bankregels binnen één bestand', () => {
  const row = fullRow({ 0: iban, 1: 'EUR', 3: '42', 4: '2026-08-03', 6: '-5,00', 19: 'Dubbele regel' });
  const r = parseRabobankCsv([csvLine(fullHeaders), csvLine(row), csvLine(row)].join('\n'));
  assert.equal(r.rowsInFile, 2); assert.equal(r.transactions.length, 1); assert.deepEqual(r.duplicateRows, [3]);
});

test('decodeert ISO-8859-1 (oude Rabo-exports) en geeft een waarschuwing', () => {
  const csv = [csvLine(['IBAN/BBAN', 'Datum', 'Bedrag', 'Naam initiërende partij']), csvLine([iban, '2026-08-04', '1,00', 'Betaler'])].join('\n');
  const r = parseRabobankCsv(Buffer.from(csv, 'latin1'));
  assert.equal(r.detection.encoding, 'iso-8859-1'); assert.equal(r.detection.columns[3], 'Naam initiërende partij');
  assert.equal(r.transactions[0].tx.amount, 100); assert.ok(r.detection.warnings.some(w => w.includes('ISO-8859-1')));
});

test('blokkeert al beschadigde tekst en ongeldige bedragen', () => {
  assert.throws(() => parseRabobankCsv(`IBAN/BBAN,Datum,Bedrag\n${iban},2026-08-01,1�00`), /originele bestand/);
  const r = parseRabobankCsv([csvLine(['IBAN/BBAN', 'Datum', 'Bedrag']), csvLine([iban, '2026-08-01', '1,2,3'])].join('\n'));
  assert.deepEqual(r.skippedRows, [{ row: 2, reason: "Ongeldig bedrag '1,2,3'." }]);
});

test('weigert een CSV die niet als Rabobank-export herkenbaar is', () => {
  assert.throws(() => parseRabobankCsv('Date,Amount\n2026-08-01,-1.00\n'), /niet herkend als Rabobank/);
  assert.throws(() => parseRabobankCsv('foo,bar\n1,2'), /Geen Rabobank-CSV/);
});

test('slaat niet-EUR-rijen over met uitleg', () => {
  const r = parseRabobankCsv([csvLine(['IBAN/BBAN', 'Munt', 'Datum', 'Bedrag']), csvLine([iban, 'USD', '2026-08-01', '1,00'])].join('\n'));
  assert.equal(r.transactions.length, 0); assert.match(r.skippedRows[0].reason, /USD/);
});

test('oud formaat zonder kopregel wordt op kolompositie gelezen', () => {
  const line = `"${iban}","EUR","RABONL2U","7","2026-01-05","2026-01-05","-12,50","900,00","","Jumbo 1","","","","bc","","","","","","pin","","","","","",""`;
  const r = parseRabobankCsv(line + '\n' + line.replace('"7"', '"8"'));
  assert.equal(r.transactions.length, 2);
  const t = r.transactions[0].tx; assert.equal(t.amount, -1250); assert.equal(t.code, 'bc'); assert.equal(t.balance, 90000); assert.equal(t.seq, 7);
});

test('bedragen en datums: strikte parsing', () => {
  assert.equal(parseAmount('+2850,00'), 285000); assert.equal(parseAmount('-1.234,56'), -123456); assert.equal(parseAmount('-0,05'), -5);
  assert.equal(parseAmount('€ 1.000'), 100000); assert.equal(parseAmount('(12,50)'), -1250); assert.equal(parseAmount('1,234.56'), 123456);
  assert.throws(() => parseAmount('12,345,6'));
  assert.equal(parseDate('15-01-2026'), '2026-01-15'); assert.equal(parseDate('20260115'), '2026-01-15');
  assert.throws(() => parseDate('2026-02-30'), /kalenderdatum/);
});

test('import-API: ISO-8859-1-bytes als base64, waarschuwingen en overgeslagen regels komen terug', async () => {
  const api = createApi(openDb(':memory:'));
  const csv = [csvLine(['IBAN/BBAN', 'Volgnr', 'Datum', 'Bedrag', 'Naam tegenpartij', 'Omschrijving-1']),
    csvLine([iban, '1', '2026-08-01', '-4,50', 'Café Zoë', 'koffie']), csvLine([iban, '2', '2026-08-02', 'kapot', 'X', 'Y'])].join('\n');
  const r = await api('POST', '/api/import', { base64: Buffer.from(csv, 'latin1').toString('base64'), name: 'rabo.csv' });
  assert.equal(r.added, 1); assert.equal(r.encoding, 'iso-8859-1'); assert.equal(r.problemCount, 1);
  assert.match(r.problems[0].reason, /Ongeldig bedrag/);
  const tx = await api('GET', '/api/transactions');
  assert.equal(tx.rows[0].payee, 'Café Zoë');
  const again = await api('POST', '/api/import', { base64: Buffer.from(csv, 'latin1').toString('base64') });
  assert.equal(again.added, 0);
  await assert.rejects(() => api('POST', '/api/import', { csv: 'Date,Amount\n1,2' }), /niet herkend/);
});

test('bij betaalproviders wordt de uiteindelijke partij de tegenpartij; zonder tegenpartij vallen we terug', () => {
  const row = (name, final, init) => fullRow({ 0: iban, 1: 'EUR', 3: String(Math.random()), 4: '2026-08-01', 6: '-10,00', 9: name, 10: final, 11: init, 19: 'betaling' });
  const csv = [csvLine(fullHeaders), csvLine(row('Mollie Payments', 'Bol.com', '')), csvLine(row('Albert Heijn', 'Iets Anders', '')),
    csvLine(row('', '', 'Jan Initiator')), csvLine(row('', 'Eindpartij BV', 'Jan Initiator'))].join('\n');
  const t = parseRabobankCsv(csv).transactions.map(x => x.tx.payee);
  assert.deepEqual(t, ['Bol.com', 'Albert Heijn', 'Jan Initiator', 'Eindpartij BV']);
});

test('foutmelding bij onbekend formaat noemt de gevonden kolommen (handig om te diagnosticeren)', () => {
  assert.throws(() => parseRabobankCsv('Boekdatum;Omschrijving;Waarde\n2026-01-01;x;1'), /Gevonden kolommen: "Boekdatum", "Omschrijving", "Waarde"/);
  assert.throws(() => parseRabobankCsv('Date,Amount\n2026-08-01,-1.00\n'), /Gevonden kolommen: "Date", "Amount"/);
});

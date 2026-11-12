import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRabobank, parseAmount } from './csv.js';
import { openDb, importTransactions } from './db.js';

assert.equal(parseAmount('+2850,00'), 285000);
assert.equal(parseAmount('-1.234,56'), -123456);
assert.equal(parseAmount('-0,05'), -5);

const txs = parseRabobank(readFileSync('samples/rabobank-voorbeeld.csv', 'utf8'));
assert.equal(txs.length, 10);
const db = openDb(':memory:');
const r1 = importTransactions(db, txs);
assert.equal(r1.added, 10);
assert.ok(r1.categorized >= 6);
const r2 = importTransactions(db, txs); // dubbele import
assert.equal(r2.added, 0); assert.equal(r2.skipped, 10);
console.log('OK', r1);

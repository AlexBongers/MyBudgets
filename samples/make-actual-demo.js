// Bouwt een fictieve Actual Budget-export (samples/actual-demo.zip) met het echte Actual-schema (subset),
// op basis van samples/rabobank-demo.csv. Ook bruikbaar als testfixture: import { buildActualDb } from './make-actual-demo.js'.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseRabobank } from '../src/rabobank.js';
import { writeZip } from '../src/zip.js';

const CAT = [[/woonbron|huur/i, 'Rent', 'Usual Expenses'], [/eneco|vattenfall|vitens|kpn/i, 'Utilities', 'Usual Expenses'], [/gemeente|belasting/i, 'Taxes', 'Usual Expenses'],
  [/zilveren|centraal beheer/i, 'Insurance', 'Usual Expenses'], [/netflix|spotify|apple/i, 'Subscriptions', 'Usual Expenses'], [/basic-fit/i, 'Sports', 'Usual Expenses'],
  [/albert|jumbo|lidl|plus|ah to go|bakkerij|slager|bakker/i, 'Groceries', 'Usual Expenses'], [/thuisbezorgd|restaurant|cafe|starbucks|pizzeria|eetcafe/i, 'Eating Out', 'Usual Expenses'],
  [/shell|tango|bp /i, 'Fuel & Parking', 'Usual Expenses'], [/ns groep/i, 'Public Transport', 'Usual Expenses'], [/kruidvat|etos|kapper/i, 'Personal Care', 'Usual Expenses'],
  [/hema|action|blokker|bol|zalando|coolblue/i, 'Shopping', 'Usual Expenses'], [/booking/i, 'Vacation', 'Usual Expenses'], [/spaarrekening/i, 'Savings', 'Investments and Savings'],
  [/salaris|werkgever/i, 'Salary', 'Income']];

/** @returns {Buffer} inhoud van db.sqlite */
export function buildActualDb(txs, { budgetType = 'tracking' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mybudgets-demo-')), file = join(dir, 'db.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, offbudget INTEGER DEFAULT 0, closed INTEGER DEFAULT 0, tombstone INTEGER DEFAULT 0, sort_order REAL);
    CREATE TABLE category_groups (id TEXT PRIMARY KEY, name TEXT, is_income INTEGER DEFAULT 0, sort_order REAL, tombstone INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0);
    CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, is_income INTEGER DEFAULT 0, cat_group TEXT, sort_order REAL, tombstone INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0);
    CREATE TABLE payees (id TEXT PRIMARY KEY, name TEXT, category TEXT, tombstone INTEGER DEFAULT 0, transfer_acct TEXT);
    CREATE TABLE transactions (id TEXT PRIMARY KEY, isParent INTEGER DEFAULT 0, isChild INTEGER DEFAULT 0, acct TEXT, category TEXT, amount INTEGER, description TEXT, notes TEXT,
      date INTEGER, imported_description TEXT, starting_balance_flag INTEGER DEFAULT 0, tombstone INTEGER DEFAULT 0, parent_id TEXT, sort_order REAL, cleared INTEGER DEFAULT 1);
    CREATE TABLE reflect_budgets (id TEXT PRIMARY KEY, month INTEGER, category TEXT, amount INTEGER DEFAULT 0, carryover INTEGER DEFAULT 0);
    CREATE TABLE zero_budgets (id TEXT PRIMARY KEY, month INTEGER, category TEXT, amount INTEGER DEFAULT 0, carryover INTEGER DEFAULT 0);
    CREATE TABLE preferences (id TEXT PRIMARY KEY, value TEXT);
  `);
  const groups = new Map(), cats = new Map(), payees = new Map(), accts = new Map();
  const grp = name => { if (!groups.has(name)) { groups.set(name, 'g' + groups.size); db.prepare('INSERT INTO category_groups (id, name, is_income) VALUES (?,?,?)').run(groups.get(name), name, name === 'Income' ? 1 : 0); } return groups.get(name); };
  const cat = (name, g) => { if (!cats.has(name)) { cats.set(name, 'c' + cats.size); db.prepare('INSERT INTO categories (id, name, is_income, cat_group) VALUES (?,?,?,?)').run(cats.get(name), name, g === 'Income' ? 1 : 0, grp(g)); } return cats.get(name); };
  const payee = (name, transfer) => { if (!payees.has(name)) { payees.set(name, 'p' + payees.size); db.prepare('INSERT INTO payees (id, name, transfer_acct) VALUES (?,?,?)').run(payees.get(name), name, transfer || null); } return payees.get(name); };
  const acct = name => { if (!accts.has(name)) { accts.set(name, 'a' + accts.size); db.prepare('INSERT INTO accounts (id, name) VALUES (?,?)').run(accts.get(name), name); } return accts.get(name); };
  const ins = db.prepare('INSERT INTO transactions (id, acct, category, amount, description, notes, date, imported_description, sort_order) VALUES (?,?,?,?,?,?,?,?,?)');
  txs.forEach((t, i) => {
    const hit = CAT.find(([re]) => re.test(t.payee + ' ' + t.description));
    const isTransfer = /spaarrekening/i.test(t.payee);            // overboeking: transfer-payee zonder categorie, zoals in echt Actual
    const category = hit && !isTransfer ? cat(hit[1], hit[2]) : null; // onbekende partijen blijven ongecategoriseerd
    const p = payee(t.payee.replace(/\s+\d{3,}.*$/, ''), isTransfer ? 'a-savings' : null);
    ins.run('t' + i, acct('Betaalrekening'), category, t.amount, p, i % 97 === 0 ? 'handmatige notitie' : null, +t.date.replace(/-/g, ''), `${t.payee} ${t.description}`.slice(0, 140), i);
  });
  // budget (tracking): maandbudget voor een paar categorieën, plus een categorie die nergens in transacties voorkomt
  const bud = db.prepare(`INSERT INTO ${budgetType === 'envelope' ? 'zero_budgets' : 'reflect_budgets'} (id, month, category, amount) VALUES (?,?,?,?)`);
  let bi = 0; for (const [name, g, euros] of [['Groceries', 'Usual Expenses', 450], ['Eating Out', 'Usual Expenses', 150], ['Fuel & Parking', 'Usual Expenses', 120], ['Gardening', 'Usual Expenses', 40]]) for (const m of [202610, 202611]) bud.run('b' + bi++, m, cat(name, g), euros * 100);
  db.prepare("INSERT INTO preferences (id, value) VALUES ('budgetType', ?)").run(budgetType);
  db.close();
  const buf = readFileSync(file); rmSync(dir, { recursive: true, force: true });
  return buf;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const txs = parseRabobank(readFileSync(new URL('./rabobank-demo.csv', import.meta.url), 'utf8'));
  const zip = writeZip({ 'db.sqlite': buildActualDb(txs), 'metadata.json': JSON.stringify({ id: 'Demo-Budget', budgetName: 'Demo Budget', resetClock: true }) });
  writeFileSync(new URL('./actual-demo.zip', import.meta.url), zip);
  console.log(`samples/actual-demo.zip: ${txs.length} transacties, ${zip.length} bytes`);
}

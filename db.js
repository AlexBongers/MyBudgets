import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

export function openDb(path = 'data/budget.db') {
  if (path !== ':memory:') mkdirSync('data', { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income','transfer')),
      color TEXT NOT NULL DEFAULT '#6b7280'
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY, date TEXT NOT NULL, amount INTEGER NOT NULL,
      payee TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      account TEXT NOT NULL DEFAULT '', counter_iban TEXT NOT NULL DEFAULT '',
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY, pattern TEXT NOT NULL UNIQUE,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS budgets (
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      month TEXT NOT NULL, amount INTEGER NOT NULL,
      PRIMARY KEY (category_id, month)
    );
  `);
  if (db.prepare('SELECT COUNT(*) c FROM categories').get().c === 0) seed(db);
  return db;
}

function seed(db) {
  const cats = [
    ['Inkomen', 'income', '#16a34a'], ['Boodschappen', 'expense', '#f59e0b'],
    ['Uit eten & drinken', 'expense', '#ef4444'], ['Wonen', 'expense', '#3b82f6'],
    ['Energie & water', 'expense', '#06b6d4'], ['Vervoer', 'expense', '#8b5cf6'],
    ['Auto', 'expense', '#6366f1'], ['Abonnementen', 'expense', '#ec4899'],
    ['Zorg & verzekeringen', 'expense', '#14b8a6'], ['Shopping', 'expense', '#f97316'],
    ['Vrije tijd', 'expense', '#a855f7'], ['Overig', 'expense', '#6b7280'],
    ['Sparen / overboeking', 'transfer', '#94a3b8'],
  ];
  const ic = db.prepare('INSERT INTO categories (name, kind, color) VALUES (?,?,?)');
  cats.forEach(c => ic.run(...c));
  const rules = {
    'Inkomen': ['salaris', 'loon '], 'Boodschappen': ['albert heijn', 'jumbo', 'lidl', 'aldi', 'plus ', 'dirk', 'ah to go'],
    'Uit eten & drinken': ['thuisbezorgd', 'mcdonald', 'starbucks', 'restaurant', 'cafe '],
    'Vervoer': ['ns groep', 'ov-chipkaart', 'ret ', 'gvb', 'ns reizigers'],
    'Auto': ['shell', 'tango', 'bp ', 'esso', 'parkeer'],
    'Abonnementen': ['netflix', 'spotify', 'disney', 'videoland', 'youtube'],
    'Zorg & verzekeringen': ['zilveren kruis', 'cz groep', 'vgz', 'menzis', 'apotheek'],
    'Shopping': ['bol.com', 'amazon', 'zalando', 'hema', 'action'],
    'Wonen': ['huur ', 'hypotheek', 'woningcorporatie'], 'Sparen / overboeking': ['spaarrekening', 'oranje spaarrekening'],
    'Energie & water': ['vattenfall', 'eneco', 'essent', 'vitens', 'waterbedrijf'],
  };
  const ir = db.prepare('INSERT OR IGNORE INTO rules (pattern, category_id) VALUES (?, (SELECT id FROM categories WHERE name=?))');
  for (const [cat, ps] of Object.entries(rules)) ps.forEach(p => ir.run(p, cat));
}

// Eerste regel die matcht (op payee + omschrijving) wint; langere patronen eerst.
export function categorize(db, tx) {
  const hay = (tx.payee + ' ' + tx.description).toLowerCase();
  const rules = db.prepare('SELECT pattern, category_id FROM rules ORDER BY length(pattern) DESC').all();
  for (const r of rules) if (hay.includes(r.pattern.toLowerCase())) return r.category_id;
  return null;
}

export function importTransactions(db, txs) {
  const ins = db.prepare(`INSERT OR IGNORE INTO transactions
    (date, amount, payee, description, account, counter_iban, category_id, key)
    VALUES (?,?,?,?,?,?,?,?)`);
  let added = 0, categorized = 0;
  db.exec('BEGIN');
  try {
    for (const t of txs) {
      const cat = categorize(db, t);
      const r = ins.run(t.date, t.amount, t.payee, t.description, t.account, t.counter_iban, cat, t.key);
      if (r.changes) { added++; if (cat) categorized++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { added, skipped: txs.length - added, categorized };
}

export function applyRules(db) {
  const rows = db.prepare('SELECT id, payee, description FROM transactions WHERE category_id IS NULL').all();
  const up = db.prepare('UPDATE transactions SET category_id=? WHERE id=?');
  let n = 0;
  for (const r of rows) { const c = categorize(db, r); if (c) { up.run(c, r.id); n++; } }
  return n;
}

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { Categorizer, AUTO_THRESHOLD, NO_IBAN_MEMORY } from './categorizer.js';
import { normIban } from './util.js';
import { merchantKey, displayName, tokensOf, tidyDescription } from './normalize.js';

export { AUTO_THRESHOLD };

/** Voer fn uit in één SQLite-transactie (alles of niets). Niet nesten. */
export const withTx = (db, fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
export const SCHEMA_VERSION = 2; // let op: kolommen worden idempotent toegevoegd in migrate()

export function openDb(path = 'data/budget.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrate(db);
  if (db.prepare('SELECT COUNT(*) c FROM categories').get().c === 0) seedCategories(db);
  else refreshDefaultColors(db);
  return db;
}

const cols = (db, t) => db.prepare(`PRAGMA table_xinfo(${t})`).all().map(c => c.name);

function migrate(db) {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, iban TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT ''
    );
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
    CREATE TABLE IF NOT EXISTS budgets (
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      month TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (category_id, month)
    );
    CREATE TABLE IF NOT EXISTS memory (
      key TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      n INTEGER NOT NULL DEFAULT 1, label TEXT NOT NULL DEFAULT '', PRIMARY KEY (key, category_id)
    );
  `);
  const addCol = (t, c, def) => { if (!cols(db, t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  addCol('categories', 'key', 'TEXT');
  addCol('categories', 'icon', "TEXT NOT NULL DEFAULT '🏷️'");
  addCol('categories', 'grp', "TEXT NOT NULL DEFAULT 'Overig'");
  addCol('categories', 'rollover', 'INTEGER NOT NULL DEFAULT 0');
  addCol('transactions', 'account_id', 'INTEGER REFERENCES accounts(id) ON DELETE SET NULL');
  addCol('transactions', 'code', "TEXT NOT NULL DEFAULT ''");
  addCol('transactions', 'seq', 'INTEGER NOT NULL DEFAULT 0');
  addCol('transactions', 'balance', 'INTEGER');
  addCol('transactions', 'merchant', "TEXT NOT NULL DEFAULT ''");
  addCol('transactions', 'cat_source', 'TEXT');
  addCol('transactions', 'cat_conf', 'REAL NOT NULL DEFAULT 0');
  addCol('transactions', 'cat_reason', "TEXT NOT NULL DEFAULT ''");
  addCol('transactions', 'confirmed', 'INTEGER NOT NULL DEFAULT 0');
  addCol('transactions', 'notes', "TEXT NOT NULL DEFAULT ''");
  addCol('transactions', 'import_id', 'INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS ignored_recurring (merchant TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '')`);
  db.exec(`CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', created TEXT NOT NULL DEFAULT (datetime('now')),
    added INTEGER NOT NULL DEFAULT 0, from_date TEXT, to_date TEXT
  )`);
  // jaar-maand als afgeleide, geïndexeerde kolom: maandfilters gebruiken zo de index i.p.v. een volledige scan
  addCol('transactions', 'ym', 'TEXT GENERATED ALWAYS AS (substr(date, 1, 7)) VIRTUAL');
  // v1-regels (alleen patroon) -> nieuw regelformaat
  if (!cols(db, 'rules').length || !cols(db, 'rules').includes('field')) {
    const old = cols(db, 'rules').length ? db.prepare('SELECT pattern, category_id FROM rules').all() : [];
    db.exec('DROP TABLE IF EXISTS rules');
    db.exec(`CREATE TABLE rules (
      id INTEGER PRIMARY KEY, field TEXT NOT NULL DEFAULT 'any', op TEXT NOT NULL DEFAULT 'contains',
      pattern TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL DEFAULT 'any',
      amount_min INTEGER, amount_max INTEGER, priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1, category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE
    )`);
    const ins = db.prepare('INSERT INTO rules (pattern, category_id) VALUES (?,?)');
    old.forEach(r => ins.run(r.pattern, r.category_id));
  }
  db.exec(`CREATE TABLE IF NOT EXISTS splits (
    id INTEGER PRIMARY KEY, tx_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, amount INTEGER NOT NULL, note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS splits_tx ON splits(tx_id);
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '🎯', target INTEGER NOT NULL,
    saved INTEGER NOT NULL DEFAULT 0, monthly INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL DEFAULT (date('now'))
  );
  DROP VIEW IF EXISTS tl;
  -- 'tl' = transactieregels: gesplitste transacties zijn vervangen door hun delen (voor budget en rapporten)
  CREATE VIEW tl AS
    SELECT t.id, t.date, t.ym, t.amount, t.payee, t.description, t.account_id, t.merchant, t.category_id FROM transactions t
      WHERE NOT EXISTS (SELECT 1 FROM splits s WHERE s.tx_id = t.id)
    UNION ALL
    SELECT t.id, t.date, t.ym, s.amount, t.payee, t.description, t.account_id, t.merchant, s.category_id FROM splits s JOIN transactions t ON t.id = s.tx_id;`);
  db.exec(`CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
           CREATE INDEX IF NOT EXISTS tx_merchant ON transactions(merchant);
           CREATE INDEX IF NOT EXISTS tx_cat ON transactions(category_id);
           CREATE INDEX IF NOT EXISTS tx_amount ON transactions(amount);
           CREATE INDEX IF NOT EXISTS tx_ym ON transactions(ym);
           CREATE INDEX IF NOT EXISTS tx_acc_date ON transactions(account_id, date, seq);`);
  if (v < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

// key, naam, soort, groep, icoon, kleur
export const DEFAULT_CATEGORIES = [
  ['salary', 'Salaris', 'income', 'Inkomen', '💼', '#2f7d57'],
  ['benefits', 'Toeslagen & uitkeringen', 'income', 'Inkomen', '🏛️', '#4c9a6e'],
  ['other_income', 'Overig inkomen', 'income', 'Inkomen', '💶', '#7cb58f'],
  ['rent', 'Huur / hypotheek', 'expense', 'Wonen', '🏠', '#2f5f8a'],
  ['energy', 'Energie', 'expense', 'Wonen', '💡', '#d9a227'],
  ['water', 'Water', 'expense', 'Wonen', '🚰', '#3e8fa8'],
  ['telecom', 'Internet & telefoon', 'expense', 'Wonen', '📡', '#5a7fb8'],
  ['taxes', 'Belastingen & heffingen', 'expense', 'Wonen', '🧾', '#6b6f7a'],
  ['home', 'Inrichting & klussen', 'expense', 'Wonen', '🛠️', '#8aa2c8'],
  ['groceries', 'Boodschappen', 'expense', 'Dagelijks', '🛒', '#d98a2b'],
  ['dining', 'Uit eten & drinken', 'expense', 'Dagelijks', '🍽️', '#c8553d'],
  ['drugstore', 'Drogist & verzorging', 'expense', 'Dagelijks', '🧴', '#d07a96'],
  ['transit', 'Openbaar vervoer', 'expense', 'Vervoer', '🚆', '#6a5aa8'],
  ['fuel', 'Brandstof & laden', 'expense', 'Vervoer', '⛽', '#8f7cc4'],
  ['car', 'Auto', 'expense', 'Vervoer', '🚗', '#4f4a8a'],
  ['healthins', 'Zorgverzekering', 'expense', 'Zorg & verzekeringen', '🩺', '#2a8a80'],
  ['health', 'Zorgkosten', 'expense', 'Zorg & verzekeringen', '💊', '#5fb3a8'],
  ['insurance', 'Verzekeringen', 'expense', 'Zorg & verzekeringen', '🛡️', '#1f6b66'],
  ['subscriptions', 'Abonnementen', 'expense', 'Vrije tijd', '📺', '#b04a7a'],
  ['shopping', 'Kleding & shopping', 'expense', 'Vrije tijd', '🛍️', '#e0814f'],
  ['leisure', 'Uitjes & entertainment', 'expense', 'Vrije tijd', '🎟️', '#9a5fb0'],
  ['travel', 'Vakantie & reizen', 'expense', 'Vrije tijd', '✈️', '#c06aa6'],
  ['sports', 'Sport', 'expense', 'Vrije tijd', '🏋️', '#7a9a3a'],
  ['gifts', 'Cadeaus & goede doelen', 'expense', 'Vrije tijd', '🎁', '#e07a7a'],
  ['education', 'Onderwijs & kinderopvang', 'expense', 'Overig', '🎓', '#4a9cc4'],
  ['bank', 'Bankkosten', 'expense', 'Overig', '🏦', '#8c8a80'],
  ['cash', 'Contant geld', 'expense', 'Overig', '💵', '#7a6f62'],
  ['other', 'Overig', 'expense', 'Overig', '🧩', '#9a958a'],
  ['transfer', 'Sparen / eigen rekening', 'transfer', 'Overboekingen', '🔁', '#8c8a80'],
  ['invest', 'Beleggen & pensioen', 'transfer', 'Overboekingen', '📈', '#6b6f7a'],
];

// Kleuren van vóór versie 2.9; categorieën die nog precies die standaardkleur hebben krijgen de nieuwe tint.
const OLD_DEFAULT_COLORS = { salary: '#16a34a', benefits: '#22c55e', other_income: '#4ade80', rent: '#3b82f6', energy: '#eab308', water: '#06b6d4', telecom: '#0ea5e9', taxes: '#64748b', home: '#60a5fa', groceries: '#f59e0b', dining: '#ef4444', drugstore: '#f472b6', transit: '#8b5cf6', fuel: '#a78bfa', car: '#6366f1', healthins: '#14b8a6', health: '#2dd4bf', insurance: '#0d9488', subscriptions: '#ec4899', shopping: '#f97316', leisure: '#a855f7', travel: '#d946ef', sports: '#84cc16', gifts: '#fb7185', education: '#38bdf8', bank: '#94a3b8', cash: '#78716c', other: '#6b7280', transfer: '#94a3b8', invest: '#64748b' };
function refreshDefaultColors(db) {
  const up = db.prepare('UPDATE categories SET color=? WHERE key=? AND color=?');
  withTx(db, () => { for (const [key, , , , , color] of DEFAULT_CATEGORIES) if (OLD_DEFAULT_COLORS[key]) up.run(color, key, OLD_DEFAULT_COLORS[key]); });
}

function seedCategories(db) {
  const ins = db.prepare('INSERT INTO categories (key, name, kind, grp, icon, color) VALUES (?,?,?,?,?,?)');
  withTx(db, () => { for (const [key, name, kind, grp, icon, color] of DEFAULT_CATEGORIES) ins.run(key, name, kind, grp, icon, color); });
}

// ---------- categorizer laden ----------
export function loadCategorizer(db) {
  const categories = db.prepare('SELECT id, key, name, kind FROM categories').all();
  const rules = db.prepare('SELECT * FROM rules').all();
  const memory = db.prepare('SELECT key, category_id, n FROM memory').all();
  const ownIbans = db.prepare('SELECT iban FROM accounts').all().map(a => a.iban);
  const training = db.prepare(`SELECT payee, description, amount, code, category_id FROM transactions
    WHERE confirmed=1 AND category_id IS NOT NULL ORDER BY id DESC LIMIT 4000`).all()
    .map(t => ({ ...t, tokens: tokensOf(t) }));
  // Partijen die in ≥3 verschillende maanden een vergelijkbaar bedrag (≥ €400, ±30%) storten
  const recurringIncome = db.prepare(`SELECT merchant FROM transactions WHERE amount > 0 AND merchant <> '' GROUP BY merchant
    HAVING COUNT(DISTINCT ym) >= 3 AND AVG(amount) >= 40000 AND MIN(amount) >= AVG(amount) * 0.7 AND MAX(amount) <= AVG(amount) * 1.3`).all().map(r => r.merchant);
  return new Categorizer({ categories, rules, memory, ownIbans, training, recurringIncome });
}

// ---------- importeren ----------
export function importTransactions(db, parsed, meta = {}) {
  return withTx(db, () => {
    const importId = Number(db.prepare('INSERT INTO imports (name) VALUES (?)').run(String(meta.name || '').slice(0, 200)).lastInsertRowid);
    const getAcc = db.prepare('SELECT id FROM accounts WHERE iban=?');
    const insAcc = db.prepare('INSERT INTO accounts (iban, name) VALUES (?,?)');
    const accId = new Map(); const newAccounts = [];
    for (const t of parsed) {
      if (accId.has(t.account)) continue;
      let a = getAcc.get(t.account);
      if (!a) { insAcc.run(t.account, t.account ? 'Rekening ' + t.account.slice(-4) : 'Rekening'); a = getAcc.get(t.account); newAccounts.push(t.account); }
      accId.set(t.account, a.id);
    }
    const ins = db.prepare(`INSERT OR IGNORE INTO transactions
      (date, amount, payee, description, account, account_id, counter_iban, code, seq, balance, merchant, key, import_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Transactie die al via een Actual-import binnen is (key 'actual|…') op dezelfde rekening/datum/bedrag? Dan nemen we de bankgegevens
    // over (volgnummer, saldo, tegenrekening, code) en behouden categorie en bevestiging, in plaats van een dubbele toe te voegen.
    const findImported = db.prepare("SELECT id FROM transactions WHERE account_id=? AND date=? AND amount=? AND key LIKE 'actual|%' ORDER BY id LIMIT 1");
    const adopt = db.prepare('UPDATE transactions SET key=?, seq=?, balance=?, counter_iban=?, code=?, account=?, import_id=? WHERE id=?');
    const exists = db.prepare('SELECT 1 FROM transactions WHERE key=?');
    let added = 0, adopted = 0, from = null, to = null;
    for (const t of parsed) {
      if (!exists.get(t.key)) {
        const hit = findImported.get(accId.get(t.account), t.date, t.amount);
        if (hit) { adopt.run(t.key, t.seq, t.balance, t.counter_iban, t.code, t.account, importId, hit.id); adopted++; continue; }
      }
      const r = ins.run(t.date, t.amount, displayName(t.payee), tidyDescription(t.description), t.account, accId.get(t.account),
        t.counter_iban, t.code, t.seq, t.balance, merchantKey(t.payee, t.description), t.key, importId);
      if (r.changes) { added++; if (!from || t.date < from) from = t.date; if (!to || t.date > to) to = t.date; }
    }
    if (added || adopted) db.prepare('UPDATE imports SET added=?, from_date=?, to_date=? WHERE id=?').run(added + adopted, from || parsed.map(t => t.date).sort()[0], to || parsed.map(t => t.date).sort().at(-1), importId);
    else db.prepare('DELETE FROM imports WHERE id=?').run(importId); // niets nieuws: geen lege importregel bewaren
    const changed = recategorize(db);
    const rev = db.prepare(`SELECT COUNT(*) c FROM transactions WHERE confirmed=0 AND (category_id IS NULL OR cat_conf < ${AUTO_THRESHOLD - 0.001})`).get().c;
    return { added, adopted, skipped: parsed.length - added - adopted, from, to, newAccounts: newAccounts.length, review: rev, recategorized: changed, importId: added || adopted ? importId : null };
  });
}

// Herclassificeer alle nog niet bevestigde transacties (bevestigde blijven onaangetast).
// scope (optioneel): { merchants, ibans } beperkt het werk tot transacties van die tegenpartijen (bijv. na een handmatige keuze).
export function recategorize(db, cz = loadCategorizer(db), scope = null) {
  let where = 'confirmed=0', args = [];
  if (scope) {
    const m = scope.merchants?.filter(Boolean) || [], i = scope.ibans?.filter(Boolean) || [];
    if (!m.length && !i.length) return 0;
    const ph = a => a.map(() => '?').join(',');
    where += ' AND (' + [m.length ? `merchant IN (${ph(m)})` : '', i.length ? `counter_iban IN (${ph(i)})` : ''].filter(Boolean).join(' OR ') + ')';
    args = [...m, ...i];
  }
  const rows = db.prepare(`SELECT id, payee, description, amount, counter_iban, code, merchant, category_id, cat_source, cat_conf FROM transactions WHERE ${where}`).all(...args);
  const up = db.prepare('UPDATE transactions SET category_id=?, cat_source=?, cat_conf=?, cat_reason=? WHERE id=?');
  let changed = 0;
  for (const r of rows) {
    const c = cz.classify(r);
    const cat = c?.category_id ?? null, src = c?.source ?? null, conf = c?.confidence ?? 0;
    if (cat !== r.category_id || src !== r.cat_source || Math.abs(conf - r.cat_conf) > 1e-9) {
      up.run(cat, src, conf, c?.reason ?? '', r.id);
      if (cat !== r.category_id) changed++;
    }
  }
  return scope ? changed : changed + linkTransfers(db);
}

// Tegengestelde bedragen op twee eigen rekeningen (binnen 3 dagen) zijn samen een overboeking,
// ook als de IBAN's niet bekend zijn. Eén-op-één, kleinste datumverschil eerst.
export function linkTransfers(db) {
  const cat = db.prepare("SELECT id FROM categories WHERE key='transfer'").get()
    || db.prepare("SELECT id FROM categories WHERE kind='transfer' ORDER BY id LIMIT 1").get();
  if (!cat || db.prepare('SELECT COUNT(*) c FROM accounts').get().c < 2) return 0;
  const pairs = db.prepare(`SELECT a.id aid, b.id bid, ABS(julianday(a.date) - julianday(b.date)) d, a.account_id aa, b.account_id ba FROM transactions a
    JOIN transactions b ON b.amount = -a.amount AND a.amount < 0 AND b.account_id <> a.account_id AND ABS(julianday(a.date) - julianday(b.date)) <= 3
    LEFT JOIN categories ca ON ca.id=a.category_id LEFT JOIN categories cb ON cb.id=b.category_id
    WHERE a.confirmed=0 AND b.confirmed=0 AND a.account_id IS NOT NULL AND b.account_id IS NOT NULL
      AND (a.cat_source IS NULL OR a.cat_conf < ${AUTO_THRESHOLD - 0.001} OR ca.kind='transfer' OR a.cat_source='pair')
      AND (b.cat_source IS NULL OR b.cat_conf < ${AUTO_THRESHOLD - 0.001} OR cb.kind='transfer' OR b.cat_source='pair')
    ORDER BY d, a.id, b.id`).all();
  const name = db.prepare('SELECT name FROM accounts WHERE id=?');
  const up = db.prepare("UPDATE transactions SET category_id=?, cat_source='pair', cat_conf=0.9, cat_reason=? WHERE id=? AND (category_id IS NOT ? OR cat_source IS NOT 'pair')");
  const used = new Set(); let n = 0;
  for (const p of pairs) {
    if (used.has(p.aid) || used.has(p.bid)) continue;
    used.add(p.aid); used.add(p.bid);
    n += up.run(cat.id, `Overboeking naar ${name.get(p.ba)?.name || 'eigen rekening'}`, p.aid, cat.id).changes;
    n += up.run(cat.id, `Overboeking van ${name.get(p.aa)?.name || 'eigen rekening'}`, p.bid, cat.id).changes;
  }
  return n;
}

// ---------- handmatig indelen + leren ----------
function learn(db, t, categoryId) {
  const bump = (key, label) => {
    // Correctie weegt zwaarder: andere categorieën voor dezelfde sleutel worden gehalveerd.
    db.prepare('UPDATE memory SET n = n / 2 WHERE key=? AND category_id<>?').run(key, categoryId);
    db.prepare('DELETE FROM memory WHERE key=? AND n<=0').run(key);
    db.prepare(`INSERT INTO memory (key, category_id, n, label) VALUES (?,?,1,?)
      ON CONFLICT(key, category_id) DO UPDATE SET n = n + 1, label = excluded.label`).run(key, categoryId, label);
  };
  if (t.merchant) bump('m:' + t.merchant, t.payee);
  if (t.counter_iban && !NO_IBAN_MEMORY.has(String(t.code || '').toLowerCase())) bump('i:' + normIban(t.counter_iban), t.payee);
}

// ids krijgen handmatig een categorie (of null = wissen). Geeft aantal gewijzigde rijen.
export function setCategory(db, ids, categoryId, { learnFrom = true } = {}) {
  return withTx(db, () => {
    const get = db.prepare('SELECT * FROM transactions WHERE id=?');
    const up = db.prepare('UPDATE transactions SET category_id=?, cat_source=?, cat_conf=?, cat_reason=?, confirmed=? WHERE id=?');
    let n = 0;
    for (const id of ids) {
      const t = get.get(id); if (!t) continue;
      if (categoryId) {
        up.run(categoryId, 'manual', 1, 'Handmatig ingedeeld', 1, id);
        if (learnFrom) learn(db, t, categoryId);
      } else up.run(null, null, 0, '', 0, id);
      n++;
    }
    return n;
  });
}

// Zet in één keer handmatige categorieën (bijv. uit een Actual-import) en leer ervan, in de gegeven volgorde
// (chronologisch: de nieuwste keuze telt het zwaarst). Draait binnen de transactie van de aanroeper.
export function applyManual(db, pairs, reason = 'Uit Actual') {
  const get = db.prepare('SELECT * FROM transactions WHERE id=?');
  const up = db.prepare('UPDATE transactions SET category_id=?, cat_source=?, cat_conf=?, cat_reason=?, confirmed=1 WHERE id=?');
  let n = 0;
  for (const p of pairs) {
    const t = get.get(p.id); if (!t || !p.category_id) continue;
    up.run(p.category_id, 'manual', 1, reason, p.id); learn(db, t, p.category_id); n++;
  }
  return n;
}

export function confirmSuggestions(db, ids) {
  return withTx(db, () => {
    const get = db.prepare('SELECT * FROM transactions WHERE id=? AND category_id IS NOT NULL');
    const up = db.prepare("UPDATE transactions SET confirmed=1, cat_source='manual', cat_conf=1, cat_reason='Bevestigd' WHERE id=?");
    let n = 0;
    for (const id of ids) { const t = get.get(id); if (!t) continue; up.run(id); learn(db, t, t.category_id); n++; }
    return n;
  });
}

// ---------- ongedaan maken ----------
// Snapshot van de toestand van transacties + het geleerde geheugen dat erdoor kan veranderen.
export function snapshot(db, ids) {
  const get = db.prepare('SELECT id, category_id, cat_source, cat_conf, cat_reason, confirmed, merchant, counter_iban FROM transactions WHERE id=?');
  const rows = ids.map(id => get.get(id)).filter(Boolean);
  const keys = new Set();
  for (const r of rows) { if (r.merchant) keys.add('m:' + r.merchant); if (r.counter_iban) keys.add('i:' + normIban(r.counter_iban)); }
  const mem = db.prepare('SELECT key, category_id, n, label FROM memory WHERE key=?');
  return { rows, keys: [...keys], memory: [...keys].flatMap(k => mem.all(k)) };
}
export function restore(db, snap) {
  return withTx(db, () => {
    // Een categorie kan sinds de snapshot verwijderd zijn: dan valt de transactie terug naar 'te beoordelen'
    const exists = db.prepare('SELECT 1 FROM categories WHERE id=?'), alive = id => id != null && !!exists.get(id);
    const up = db.prepare('UPDATE transactions SET category_id=?, cat_source=?, cat_conf=?, cat_reason=?, confirmed=? WHERE id=?');
    for (const r of snap.rows) {
      if (r.category_id == null || alive(r.category_id)) up.run(r.category_id, r.cat_source, r.cat_conf, r.cat_reason, r.confirmed, r.id);
      else up.run(null, null, 0, '', 0, r.id);
    }
    const del = db.prepare('DELETE FROM memory WHERE key=?'), ins = db.prepare('INSERT INTO memory (key, category_id, n, label) VALUES (?,?,?,?)');
    for (const k of snap.keys) del.run(k);
    for (const m of snap.memory) if (alive(m.category_id)) ins.run(m.key, m.category_id, m.n, m.label);
    return recategorize(db);
  });
}

// Consistente kopie van de database (ook midden in een schrijfactie veilig, werkt met WAL).
export function backupTo(db, path) {
  if (existsSync(path)) unlinkSync(path);
  db.exec(`VACUUM INTO '${String(path).replace(/'/g, "''")}'`);
  return path;
}

// Alle gegevens wissen behalve categorieën, regels en spaardoelen; in één transactie, dus alles of niets.
export function resetAll(db) {
  withTx(db, () => {
    for (const t of ['splits', 'transactions', 'imports', 'memory', 'budgets', 'accounts', 'ignored_recurring']) db.exec(`DELETE FROM ${t}`);
  });
}

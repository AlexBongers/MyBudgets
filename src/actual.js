// Importer voor een Actual Budget-export ("Settings → Export data" levert een ZIP met db.sqlite + metadata.json).
// We lezen de SQLite-database rechtstreeks (alleen-lezen) en zetten hem om naar tabellen (Transacties, Budgetten),
// zodat de wizard (voorbeeld, categorie- en rekeningkoppeling, verrijken, leren, importgeschiedenis) hetzelfde werkt.
//
// Actual-datamodel (voor zover relevant):
//   transactions: acct, category, amount (centen), date (YYYYMMDD als getal), description = payee-id, imported_description = ruwe banktekst,
//                 notes, isParent/isChild/parent_id (splitsingen), tombstone = verwijderd, starting_balance_flag
//   payees(name, transfer_acct)  categories(name, is_income, cat_group)  category_groups  accounts(name, offbudget, closed)
//   reflect_budgets (tracking-budget) of zero_budgets (envelope-budget): month YYYYMM, category, amount (centen)
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const isSqlite = buf => buf.length > 16 && buf.subarray(0, 15).toString('latin1') === 'SQLite format 3';

const isoDate = n => { const s = String(n); return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : ''; };
const isoMonth = n => { const s = String(n); return s.length >= 6 ? `${s.slice(0, 4)}-${s.slice(4, 6)}` : ''; };
const money = cents => (cents / 100).toFixed(2); // altijd met punt; de tabel meldt decimal: '.'

/** @returns {{name, headers, rows, decimal, source, categoryMeta?}[]} tabellen: Transacties en (indien aanwezig) Budgetten */
export function actualTables(sqliteBuffer) {
  const dir = mkdtempSync(join(tmpdir(), 'mybudgets-actual-'));
  let db;
  try {
    const file = join(dir, 'db.sqlite'); writeFileSync(file, sqliteBuffer);
    db = new DatabaseSync(file, { readOnly: true });
    const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!has('transactions') || !has('accounts') || !has('categories')) throw new Error('Dit SQLite-bestand lijkt geen Actual Budget-database (tabellen transactions/accounts/categories ontbreken).');
    const all = sql => db.prepare(sql).all();

    const accounts = new Map(all('SELECT id, name FROM accounts WHERE COALESCE(tombstone,0)=0').map(a => [a.id, a.name]));
    const catRows = all('SELECT c.id, c.name, c.is_income, g.name grp FROM categories c LEFT JOIN category_groups g ON g.id=c.cat_group WHERE COALESCE(c.tombstone,0)=0');
    const cats = new Map(catRows.map(c => [c.id, c]));
    const payees = new Map(all('SELECT id, name, transfer_acct FROM payees WHERE COALESCE(tombstone,0)=0').map(p => [p.id, p]));
    const categoryMeta = Object.fromEntries(catRows.map(c => [c.name, { income: !!c.is_income, group: c.grp || '' }]));

    const txs = all(`SELECT id, acct, category, amount, description payee_id, imported_description, notes, date, isParent, isChild, parent_id, starting_balance_flag
                     FROM transactions WHERE COALESCE(tombstone,0)=0 ORDER BY date, sort_order DESC, id`);
    // splitsing: de ouder telt, kinderen niet; de categorie van het grootste kind geeft de ouder een categorie
    const childCat = new Map();
    for (const t of txs) if (t.isChild && t.parent_id && t.category) { const o = childCat.get(t.parent_id); if (!o || Math.abs(t.amount) > Math.abs(o.amount)) childCat.set(t.parent_id, { category: t.category, amount: t.amount }); }

    const headers = ['Datum', 'Bedrag', 'Tegenpartij', 'Omschrijving', 'Categorie', 'Rekening', 'Notities'], rows = [];
    let skippedStart = 0;
    for (const t of txs) {
      if (t.isChild) continue;
      if (t.starting_balance_flag) { skippedStart++; continue; } // startsaldo is geen echte transactie
      const acct = accounts.get(t.acct); if (!acct || !isoDate(t.date)) continue;
      const p = payees.get(t.payee_id);
      const raw = (t.imported_description || '').trim();
      const payee = (p?.name || raw || 'Onbekend').trim();
      let category = t.category ? cats.get(t.category)?.name || '' : '';
      if (t.isParent && !category) category = cats.get(childCat.get(t.id)?.category)?.name || '';
      if (!category && p?.transfer_acct) category = 'Overboeking';
      rows.push([isoDate(t.date), money(t.amount), payee, raw, category, acct, (t.notes || '') + (t.isParent ? ' (gesplitst in Actual)' : '')].map(v => String(v).trim()));
    }
    const out = [{ name: 'Transacties', headers, rows, decimal: '.', source: 'actual', categoryMeta, skippedStart }];

    // budget: tracking (reflect_budgets) of envelope (zero_budgets), afhankelijk van de voorkeur in het bestand
    const type = has('preferences') ? all("SELECT value FROM preferences WHERE id='budgetType'")[0]?.value : '';
    const btable = type === 'envelope' && has('zero_budgets') ? 'zero_budgets' : has('reflect_budgets') ? 'reflect_budgets' : null;
    if (btable) {
      const brows = all(`SELECT month, category, amount FROM ${btable} WHERE amount<>0 ORDER BY month`)
        .filter(b => cats.has(b.category) && !cats.get(b.category).is_income && isoMonth(b.month))
        .map(b => [cats.get(b.category).name, isoMonth(b.month), money(Math.abs(b.amount))]);
      if (brows.length) out.push({ name: 'Budgetten', headers: ['Categorie', 'Maand', 'Budget'], rows: brows, decimal: '.', source: 'actual', categoryMeta });
    }
    if (!rows.length) throw new Error('Er zijn geen transacties gevonden in deze Actual-export.');
    return out;
  } finally {
    try { db?.close(); } catch { /* al gesloten */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tijdelijke map blijft hooguit even staan */ }
  }
}

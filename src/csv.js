// CSV-parser + Rabobank-mapping (geen dependencies)
export function parseCSV(text, delim) {
  text = text.replace(/^﻿/, '');
  if (!delim) {
    const first = text.split(/\r?\n/)[0] || '';
    delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  }
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some(v => v !== '')) rows.push(row);
  return rows;
}

export function parseAmount(s) {
  s = String(s || '').trim().replace(/^\+/, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error('Ongeldig bedrag: ' + s);
  return Math.round(n * 100); // centen
}

export function parseDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  throw new Error('Ongeldige datum: ' + s);
}

// Rabobank-kolommen: IBAN/BBAN, Munt, BIC, Volgnr, Datum, Rentedatum, Bedrag, Saldo na trn,
// Tegenrekening IBAN/BBAN, Naam tegenpartij, Naam uiteindelijke partij, Naam initiërende partij,
// BIC tegenpartij, Code, Batch ID, Transactiereferentie, Machtigingskenmerk, Incassant ID,
// Betalingskenmerk, Omschrijving-1..3, Reden retour, Oorspr bedrag, Oorspr munt, Koers
const POSITIONAL = { iban: 0, seq: 3, date: 4, amount: 6, balance: 7, cpIban: 8, payee: 9, code: 13, d1: 19, d2: 20, d3: 21 };
const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{4}\d{6,}/i;

export function parseRabobank(text) {
  const rows = parseCSV(text);
  if (rows.length < 1) throw new Error('Leeg bestand');
  const norm = h => h.trim().toLowerCase();
  const head = rows[0].map(norm);
  const col = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  let ix, data;
  if (head.includes('datum') && head.includes('bedrag')) {
    ix = {
      iban: col('iban/bban', 'rekeningnummer'), seq: col('volgnr'), date: col('datum'), amount: col('bedrag'),
      balance: col('saldo na trn', 'saldo na transactie'), code: col('code'),
      cpIban: col('tegenrekening iban/bban', 'tegenrekeningnummer'), payee: col('naam tegenpartij'),
      d1: col('omschrijving-1'), d2: col('omschrijving-2'), d3: col('omschrijving-3'),
    };
    data = rows.slice(1);
  } else if (IBAN_RE.test(rows[0][0] || '') && rows[0].length >= 10) {
    ix = POSITIONAL; data = rows; // oud formaat zonder kopregel
  } else throw new Error('Geen Rabobank-CSV: kolommen Datum/Bedrag ontbreken. Exporteer als CSV (kommagescheiden) uit Rabo Internetbankieren.');
  const g = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
  const out = [];
  data.forEach((r, n) => {
    if (!g(r, ix.date) && !g(r, ix.amount)) return;
    let date, amount;
    try { date = parseDate(g(r, ix.date)); amount = parseAmount(g(r, ix.amount)); }
    catch (e) { throw new Error(`Regel ${n + 2}: ${e.message}`); }
    const description = [g(r, ix.d1), g(r, ix.d2), g(r, ix.d3)].filter(Boolean).join(' ').replace(/\s+/g, ' ');
    const iban = g(r, ix.iban).replace(/\s+/g, '');
    const seq = g(r, ix.seq);
    let balance = null; try { const b = g(r, ix.balance); if (b) balance = parseAmount(b); } catch { /* optioneel */ }
    out.push({
      date, amount, payee: g(r, ix.payee) || description.slice(0, 40) || 'Onbekend', description,
      account: iban, counter_iban: g(r, ix.cpIban).replace(/\s+/g, ''), code: g(r, ix.code).toLowerCase(),
      seq: Number(seq) || 0, balance, key: [iban, seq, date, amount].join('|'),
    });
  });
  if (!out.length) throw new Error('Geen transacties gevonden in het bestand');
  return out;
}

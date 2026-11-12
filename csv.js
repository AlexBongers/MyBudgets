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
// Tegenrekening IBAN/BBAN, Naam tegenpartij, ..., Omschrijving-1..3
export function parseRabobank(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('Leeg bestand');
  const norm = h => h.trim().toLowerCase();
  const head = rows[0].map(norm);
  const col = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const ix = {
    iban: col('iban/bban'), seq: col('volgnr'), date: col('datum'), amount: col('bedrag'),
    cpIban: col('tegenrekening iban/bban'), payee: col('naam tegenpartij'),
    d1: col('omschrijving-1'), d2: col('omschrijving-2'), d3: col('omschrijving-3'),
  };
  if (ix.date < 0 || ix.amount < 0) throw new Error('Geen Rabobank-CSV: kolommen Datum/Bedrag ontbreken');
  const g = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
  return rows.slice(1).map(r => {
    const date = parseDate(g(r, ix.date));
    const amount = parseAmount(g(r, ix.amount));
    const description = [g(r, ix.d1), g(r, ix.d2), g(r, ix.d3)].filter(Boolean).join(' ').replace(/\s+/g, ' ');
    let payee = g(r, ix.payee);
    if (!payee) payee = description.slice(0, 40) || 'Onbekend';
    const iban = g(r, ix.iban);
    return {
      date, amount, payee, description, account: iban, counter_iban: g(r, ix.cpIban),
      key: [iban, g(r, ix.seq), date, amount].join('|'),
    };
  });
}

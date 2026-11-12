// Rabobank CSV-parser. Overgenomen (getrouw gepoort naar JavaScript) uit AlexBongers/actual-budget-mcp
// (src/rabobank.ts), aangevuld met saldo, volgnummer en het oude formaat zonder kopregel.
//
// - detecteert scheidingsteken (, ; tab |) en codering (UTF-8, UTF-8+BOM, ISO-8859-1/Windows-1252)
// - repareert kapotte aanhalingstekens, met regelnummers in de waarschuwingen
// - kent Nederlandse en Engelse kolomnamen; valideert elke rij tegen het aantal kolommen
// - strikte datum- en bedragparsing (centen als gehele getallen); alleen EUR
// - dubbele rijen binnen één bestand worden herkend via een vingerafdruk
import { createHash } from 'node:crypto';

const SEPARATORS = [',', ';', '\t', '|'];
const MAX_WARNINGS = 50;

const HEADER_ALIASES = {
  accountIban: ['ibanbban', 'eigenrekening', 'eigenrekeningiban', 'rekeningiban', 'rekeningnummer', 'accountiban'],
  currency: ['munt', 'valuta', 'currency'],
  date: ['datum', 'boekdatum', 'transactiedatum', 'date', 'valuedate'],
  amount: ['bedrag', 'amount'],
  balance: ['saldonatrn', 'saldonatransactie', 'saldo', 'balance'],
  counterpartyIban: ['tegenrekeningibanbban', 'tegenrekeningiban', 'counterpartyiban', 'counteraccountiban', 'counteraccount'],
  counterpartyName: ['naamtegenpartij', 'naamtegenrekening', 'counterpartyname', 'tegenpartij', 'relatie'],
  finalParty: ['naamuiteindelijkepartij', 'ultimatepartyname'],
  initiatingParty: ['naaminitierendepartij', 'initiatingpartyname'],
  reference: ['transactiereferentie', 'transactiereference', 'transactionreference'],
  code: ['code', 'transactioncode', 'transactiesoort'],
  sourceId: ['volgnr', 'volgnummer', 'sequencenumber', 'transactionid'],
};

// Standaard Rabobank-kolomvolgorde, voor oude exports zonder kopregel
const LEGACY_HEADERS = ['IBAN/BBAN', 'Munt', 'BIC', 'Volgnr', 'Datum', 'Rentedatum', 'Bedrag', 'Saldo na trn',
  'Tegenrekening IBAN/BBAN', 'Naam tegenpartij', 'Naam uiteindelijke partij', 'Naam initiërende partij', 'BIC tegenpartij',
  'Code', 'Batch ID', 'Transactiereferentie', 'Machtigingskenmerk', 'Incassant ID', 'Betalingskenmerk',
  'Omschrijving-1', 'Omschrijving-2', 'Omschrijving-3', 'Reden retour', 'Oorspr bedrag', 'Oorspr munt', 'Koers'];
const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{4}\d{6,}/i;

const normalizeHeader = v => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * @param {string|Uint8Array} input  tekst, of bij voorkeur de originele bytes (voor betrouwbare coderingsdetectie)
 * @param {{fileName?: string}} options
 */
export function parseRabobankCsv(input, options = {}) {
  const decoded = decodeCsv(input);
  const warnings = [...decoded.warnings];
  const text = decoded.text.replace(/^﻿/, '');
  const separator = detectSeparator(text);
  const parsedCsv = parseCsvRows(text, separator);
  warnings.push(...parsedCsv.warnings);

  let headerRow = parsedCsv.rows.find(r => r.fields.some(c => c.trim()));
  if (!headerRow) throw new Error('Het bestand is leeg.');
  let headerIndex = parsedCsv.rows.indexOf(headerRow);
  let columns = headerRow.fields.map(c => c.trim());
  let columnMap = mapColumns(columns);
  let legacy = false;
  if ((columnMap.date === undefined || columnMap.amount === undefined) && IBAN_RE.test(columns[0] || '') && columns.length >= 10) {
    // oud formaat zonder kopregel: kolommen op positie, de eerste rij is al data
    legacy = true; headerIndex = headerIndex - 1;
    columns = LEGACY_HEADERS.slice(0, columns.length); columnMap = mapColumns(columns);
  }
  const normCols = columns.map(normalizeHeader);
  const strong = legacy || ['ibanbban', 'rentedatum', 'saldonatrn', 'tegenrekeningibanbban', 'tegenrekeningiban', 'transactiereferentie', 'volgnr']
    .some(n => normCols.includes(n));
  const filenameHint = /(^|[^a-z])rabo(bank)?([^a-z]|$)/i.test(options.fileName ?? '');
  const hasRequired = columnMap.date !== undefined && columnMap.amount !== undefined;
  const isRabobank = hasRequired && (strong || filenameHint);
  const detection = { isRabobank, separator, encoding: decoded.encoding, columns, warnings: uniqueWarnings(warnings) };

  const found = `Gevonden kolommen: ${columns.slice(0, 14).map(c => `"${c}"`).join(', ')}${columns.length > 14 ? ', …' : ''}.`;
  if (!hasRequired) throw new Error(`Geen Rabobank-CSV: de kolommen Datum en Bedrag ontbreken. Exporteer als CSV (kommagescheiden) uit Rabo Internetbankieren. ${found}`);
  if (!isRabobank) throw new Error(`Dit bestand is niet herkend als Rabobank-export. Verwacht kolommen zoals IBAN/BBAN, Rentedatum, Saldo na trn of Transactiereferentie. ${found}`);

  const dataRows = parsedCsv.rows.slice(headerIndex + 1)
    .filter(r => r.fields.some(c => c.trim()));
  const transactions = [], duplicateRows = [], skippedRows = [], fingerprints = new Set();

  for (const { line, fields: row } of dataRows) {
    if (row.length !== columns.length) {
      skippedRows.push({ row: line, reason: `Aantal kolommen klopt niet: verwacht ${columns.length}, gevonden ${row.length}.` });
      continue;
    }
    const get = i => (i === undefined ? '' : (row[i] ?? '').trim());
    const dateRaw = get(columnMap.date), amountRaw = get(columnMap.amount);
    if (!dateRaw && !amountRaw) continue;
    if (!dateRaw || !amountRaw) { skippedRows.push({ row: line, reason: 'Datum of bedrag ontbreekt.' }); continue; }
    try {
      const date = parseDate(dateRaw), amount = parseAmount(amountRaw);
      const currency = get(columnMap.currency).toUpperCase();
      if (currency && currency !== 'EUR' && currency !== 'EURO') {
        skippedRows.push({ row: line, reason: `Valuta '${currency}' wordt niet ondersteund; alleen EUR.` }); continue;
      }
      const counterpartyIban = get(columnMap.counterpartyIban).replace(/\s+/g, '');
      const counterpartyName = get(columnMap.counterpartyName), finalParty = get(columnMap.finalParty), initiatingParty = get(columnMap.initiatingParty);
      const reference = get(columnMap.reference), sourceId = get(columnMap.sourceId), code = get(columnMap.code);
      const accountIban = get(columnMap.accountIban).replace(/\s+/g, '');
      const description = columnMap.descriptions.map(i => (row[i] ?? '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
      const fingerprint = makeFingerprint({ accountIban, sourceId, date, amount, counterpartyIban, counterpartyName, description, reference, code });
      if (fingerprints.has(fingerprint)) { duplicateRows.push(line); continue; }
      fingerprints.add(fingerprint);
      let balance = null;
      try { const b = get(columnMap.balance); if (b) balance = parseAmount(b); } catch { /* saldo is optioneel */ }
      transactions.push({
        row: line, fingerprint,
        tx: {
          date, amount, payee: pickPayee({ counterpartyName, finalParty, initiatingParty }) || description.slice(0, 40) || reference || 'Onbekend', description,
          account: accountIban, counter_iban: counterpartyIban, code: code.toLowerCase(), seq: Number(sourceId) || 0, balance,
          // Sleutel in de database: tolerant voor verschillen tussen exportformaten (omschrijving e.d.)
          key: [accountIban, sourceId, date, amount].join('|'),
        },
      });
    } catch (e) { skippedRows.push({ row: line, reason: e instanceof Error ? e.message : 'Ongeldige transactie.' }); }
  }
  detection.warnings = uniqueWarnings(warnings);
  return { detection, rowsInFile: dataRows.length, transactions, duplicateRows, skippedRows };
}

/** Gemak: alleen de transacties; gooit een fout als er niets te importeren is. */
export function parseRabobank(input, options) {
  const r = parseRabobankCsv(input, options);
  if (!r.transactions.length) throw new Error(r.skippedRows.length ? `Geen bruikbare transacties. Eerste probleem: regel ${r.skippedRows[0].row}: ${r.skippedRows[0].reason}` : 'Geen transacties gevonden in het bestand');
  return r.transactions.map(t => t.tx);
}

function decodeCsv(input) {
  if (typeof input === 'string') {
    if (input.includes('�')) throw new Error('De tekst bevat ongeldige tekens (�). Lees het originele bestand in zodat de codering goed herkend kan worden.');
    return { text: input, encoding: input.startsWith('﻿') ? 'utf8-bom' : 'utf8', warnings: [] };
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const content = bom ? bytes.subarray(3) : bytes;
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(content), encoding: bom ? 'utf8-bom' : 'utf8', warnings: [] }; }
  catch {
    return { text: new TextDecoder('iso-8859-1').decode(content), encoding: 'iso-8859-1',
      warnings: ['Het bestand was geen geldig UTF-8; gelezen als ISO-8859-1/Windows-1252.'] };
  }
}

function detectSeparator(text) {
  const first = text.split(/\r?\n/).find(l => l.trim().length > 0) ?? '';
  let best = ',', bestCount = -1;
  for (const s of SEPARATORS) { const n = countOutsideQuotes(first, s); if (n > bestCount) { best = s; bestCount = n; } }
  if (bestCount < 1) throw new Error('Het scheidingsteken van het CSV-bestand kon niet worden bepaald.');
  return best;
}
function countOutsideQuotes(text, sep) {
  let inQ = false, n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (inQ && text[i + 1] === '"') i++; else inQ = !inQ; } else if (!inQ && c === sep) n++;
  }
  return n;
}

function parseCsvRows(text, sep) {
  const rows = [], warnings = [];
  let row = [], field = '', inQuotes = false, currentLine = 1, rowStartLine = 1;
  const addWarning = w => { const m = `Regel ${currentLine}: ${w}`; if (warnings.length < MAX_WARNINGS && !warnings.includes(m)) warnings.push(m); };
  const finishField = () => { row.push(field); field = ''; };
  const finishRow = () => { finishField(); rows.push({ line: rowStartLine, fields: row }); row = []; };
  const finishLine = () => { currentLine++; rowStartLine = currentLine; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          const after = text[i + 2];
          if (after === undefined || after === sep || after === '\n' || after === '\r') {
            field += '"'; inQuotes = false; i++;
            addWarning('Een defecte dubbele aanhalingsteken aan het einde van een veld is hersteld.');
          } else { field += '"'; i++; }
        } else {
          const next = text[i + 1];
          if (next === undefined || next === sep || next === '\n' || next === '\r') inQuotes = false;
          else { field += '"'; addWarning('Een los aanhalingsteken in een veld is behouden.'); }
        }
      } else if (c === '\r' || c === '\n') {
        inQuotes = false;
        addWarning('Een regeleinde binnen een open aanhalingsteken is hersteld als nieuwe transactieregel.');
        finishRow(); if (c === '\r' && text[i + 1] === '\n') i++; finishLine();
      } else field += c;
    } else if (c === '"' && field.length === 0) inQuotes = true;
    else if (c === sep) finishField();
    else if (c === '\r' || c === '\n') { finishRow(); if (c === '\r' && text[i + 1] === '\n') i++; finishLine(); }
    else if (c === '"') { field += c; addWarning('Een aanhalingsteken buiten een geciteerd veld is behouden.'); }
    else field += c;
  }
  if (inQuotes) addWarning('Het laatste geciteerde veld was niet gesloten en is hersteld.');
  if (field.length > 0 || row.length > 0) finishRow();
  return { rows, warnings };
}

function mapColumns(columns) {
  const norm = columns.map(normalizeHeader);
  const find = key => { const i = norm.findIndex(n => HEADER_ALIASES[key].includes(n)); return i >= 0 ? i : undefined; };
  const descriptions = norm.reduce((r, n, i) => { if (n.startsWith('omschrijving') || n.startsWith('description') || n.startsWith('narrative')) r.push(i); return r; }, []);
  return Object.fromEntries([...Object.keys(HEADER_ALIASES).map(k => [k, find(k)]), ['descriptions', descriptions]]);
}

export function parseDate(value) {
  const n = String(value).trim().split(/[ T]/, 1)[0] ?? '';
  let result, m = /^(\d{4})[-/.](\d{2})[-/.](\d{2})$/.exec(n);
  if (m) result = `${m[1]}-${m[2]}-${m[3]}`;
  else { m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(n); if (m) result = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  if (!result && /^\d{8}$/.test(n)) result = `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6)}`;
  if (!result) throw new Error(`Ongeldige datum '${value}'.`);
  const d = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== result) throw new Error(`Ongeldige kalenderdatum '${result}'.`);
  return result;
}

export function parseAmount(value) {
  let n = String(value).trim().replace(/[€$£]/g, '').replace(/[\s ]/g, '');
  const paren = n.startsWith('(') && n.endsWith(')');
  if (paren) n = n.slice(1, -1);
  const negative = n.startsWith('-') || paren;
  n = n.replace(/^[+-]/, '');
  const bad = () => new Error(`Ongeldig bedrag '${value}'.`);
  if (!/^\d[\d.,]*$/.test(n)) throw bad();
  const commas = n.split(',').length - 1, dots = n.split('.').length - 1;
  const grouped = (v, sep) => { const g = v.split(sep); if (!/^\d{1,3}$/.test(g[0] ?? '') || g.slice(1).some(x => !/^\d{3}$/.test(x))) throw bad(); return g.join(''); };
  let int, frac = '';
  if (commas > 0 && dots > 0) {
    const comma = n.lastIndexOf(','), dot = n.lastIndexOf('.');
    const dec = comma > dot ? ',' : '.', grp = dec === ',' ? '.' : ',', idx = Math.max(comma, dot);
    const rawInt = n.slice(0, idx); frac = n.slice(idx + 1);
    if (!/^\d{1,2}$/.test(frac) || rawInt.includes(dec)) throw bad();
    int = grouped(rawInt, grp);
  } else if (commas > 0 || dots > 0) {
    const sep = commas > 0 ? ',' : '.', parts = n.split(sep), last = parts.at(-1) ?? '';
    if (parts.length === 2 && /^\d{1,2}$/.test(last)) { int = parts[0] ?? ''; frac = last; if (!/^\d+$/.test(int)) throw bad(); }
    else int = grouped(n, sep);
  } else int = n;
  const cents = Number(`${int}${frac.padEnd(2, '0')}`);
  if (!Number.isSafeInteger(cents)) throw new Error(`Bedrag '${value}' is te groot.`);
  return negative ? -cents : cents;
}

// Bij betalingen via een betaalprovider (iDEAL, Mollie, Adyen, PayPal…) is de tegenpartij de provider; de echte
// winkel staat dan in "Naam uiteindelijke partij". Zonder tegenpartij vallen we terug op uiteindelijke/initiërende partij.
const PSP = /^(mollie|adyen|buckaroo|multisafepay|paypal|stripe|ccv|sisow|payplaza|worldline|ingenico|targetpay|digiwallet|pay\.?nl|sumup|zettle|klarna|afterpay|riverty|rabo omnikassa|omnikassa|paynl)\b/i;
export function pickPayee({ counterpartyName, finalParty, initiatingParty }) {
  if (finalParty && finalParty !== counterpartyName && (!counterpartyName || PSP.test(counterpartyName))) return finalParty;
  return counterpartyName || initiatingParty || '';
}

function makeFingerprint(values) {
  const input = Object.entries(values).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v).trim().toLowerCase()}`).join('\u001f');
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
const uniqueWarnings = w => [...new Set(w)].slice(0, MAX_WARNINGS);

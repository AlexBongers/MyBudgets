// Normalisatie van Rabobank-tegenpartijen en omschrijvingen.
// Rabo-teksten zitten vol ruis (pasvolgnummers, datums, winkelnummers, plaatsnamen);
// hier maken we er een stabiele "winkelsleutel" van zodat "ALBERT HEIJN 1234 EINDHOVEN" en
// "Albert Heijn 5678" dezelfde winkel zijn.

const NOISE = [
  /\b[a-z]{2}\d{2}[a-z]{4}\d{7,16}\b/g,                  // IBAN
  /\b\d{1,2}[-./]\d{1,2}[-./]\d{2,4}\b/g,                // datums
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,                       // tijden
  /\b(?:pasvolgnr|pas|transactie|term|kenmerk|betalingskenmerk|machtiging|machtigingskenmerk|incassant|volgnr|nr|ref|referentie|bic|iban|naam|omschrijving|valutadatum|datum|tijd|kaartnr|pasnr)\s*:\s*\S*/g,
  /\bpas\s?\d+\b/g,
  /^\s*(?:bea|gea)\b[\s,]*/,
  /\b(?:apple pay|google pay|betaalpas|contactloos|ideal|sepa overboeking|sepa incasso algemeen doorlopend|sepa incasso|incasso|overboeking|maestro|v pay|vpay)\b/g,
];
const COUNTRY = new Set(['nld', 'deu', 'bel', 'usa', 'gbr', 'fra', 'esp', 'irl', 'lux', 'nl']);
const STOP = new Set(['de', 'het', 'een', 'van', 'der', 'den', 'bv', 'nv', 'b', 'v', 'stichting', 'stg', 'the', 'en', 'te']);

export const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function clean(s) {
  s = fold(s).replace(/https?:\/\//g, ' ').replace(/\bwww\./g, ' ');
  for (const re of NOISE) s = s.replace(re, ' ');
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  const t = s.split(/\s+/).filter(Boolean).filter(w =>
    !/^\d+$/.test(w) && !/\d{4,}/.test(w) && !(/\d/.test(w) && /[a-z]/.test(w) && w.length >= 6));
  while (t.length > 1 && COUNTRY.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

// Sleutel waarmee we een winkel/tegenpartij herkennen. Bij pinbetalingen staat de winkelnaam
// vóór het winkelnummer ("Starbucks 4831 Breda"): alles na het nummer (de plaats) negeren we.
// Anders: de eerste 2 betekenisvolle woorden.
export function merchantKey(payee, description = '') {
  const raw = fold(payee).replace(/\s+/g, ' ');
  const cut = raw.search(/\s\d{3,}(\s|$)/);
  let c = clean(cut > 0 ? raw.slice(0, cut) : raw);
  if (!c) c = clean(description);
  const w = c.split(' ').filter(Boolean);
  let m = w.filter(x => !STOP.has(x) && x.length > 1);
  if (!m.length) m = w.filter(x => !STOP.has(x));
  return (m.length ? m : w).slice(0, 2).join(' ');
}

// Leesbare naam: HOOFDLETTERS -> Titel Hoofdletters, winkelnummers eraf.
const PARTICLES = new Set(['de', 'het', 'van', 'der', 'den', 'en', 'te', 'ten', 'ter', 'op', 'in']);
export function displayName(payee) {
  let s = String(payee ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+\d{3,}\b.*$/, '').trim() || s;
  if (s && s === s.toUpperCase() && /[A-Z]/.test(s)) {
    // HOOFDLETTERS -> Titel Hoofdletters; korte afkortingen (KPN, NS, AH, B.V.) blijven staan
    s = s.split(' ').map((w, i) => {
      const letters = w.replace(/[^A-Za-z]/g, '');
      if (letters.length <= 3 && !PARTICLES.has(w.toLowerCase())) return w;
      if (i > 0 && PARTICLES.has(w.toLowerCase())) return w.toLowerCase();
      return w.toLowerCase().replace(/(^|[\-/.(])([a-zà-ÿ])/g, (_, a, b) => a + b.toUpperCase());
    }).join(' ');
  }
  return s;
}

// Tokens voor het leermodel (Naive Bayes)
export function tokensOf(tx) {
  const base = clean(`${tx.payee || ''} ${tx.description || ''}`).split(' ')
    .filter(w => w.length > 1 && !STOP.has(w));
  base.push(tx.amount >= 0 ? '__in' : '__out');
  if (tx.code) base.push('__code_' + String(tx.code).toLowerCase());
  return base;
}

// Omschrijving voor weergave: pasvolgnummer, transactie-id, terminal en datum/tijd van de pinbetaling eraf.
export function tidyDescription(d) {
  return String(d ?? '')
    .replace(/\b(?:pasvolgnr|transactie|term)\s*:\s*\S*/gi, ' ')
    .replace(/\b\d{1,2}[-./]\d{1,2}[-./]\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

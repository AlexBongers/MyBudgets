// Genereert een realistische Rabobank-CSV (met typische ruis) voor demo en tests.
// Gebruik: node samples/generate.js > samples/rabobank-demo.csv
const IBAN = 'NL12RABO0123456789', SAVINGS = 'NL82RABO0300000001';
let s = 42; const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + rnd() * (b - a);
const MND = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const hex = n => Array.from({ length: n }, () => '0123456789ABCDEF'[Math.floor(rnd() * 16)]).join('');
const rows = [];
const add = (date, amount, payee, desc = '', { code = 'ov', iban = '', d2 = '', d3 = '' } = {}) => rows.push({ date, amount: Math.round(amount * 100), payee, desc, code, iban, d2, d3 });
const dstr = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d, 28)).padStart(2, '0')}`;
const dmy = d => `${d.slice(8)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
const pin = (date, amount, payee, city, code = pick(['ba', 'bc'])) =>
  add(date, amount, `${payee} ${Math.floor(between(1000, 9999))} ${city}`, `Pasvolgnr:${String(Math.floor(between(1, 30))).padStart(3, '0')} ${dmy(date)} ${String(Math.floor(between(8, 21))).padStart(2, '0')}:${String(Math.floor(between(0, 59))).padStart(2, '0')} Transactie:${hex(6)} Term:${hex(4)}`, { code });

for (let k = 0; k < 15; k++) {
  const y = 2025 + Math.floor((8 + k) / 12), m = (8 + k) % 12 + 1, M = MND[m - 1];
  if (y === 2026 && m > 11) break;
  add(dstr(y, m, 25), 3150, 'Werkgever Acme B.V.', `Salaris ${M} ${y}`, { iban: 'NL44INGB0001234567' });
  if (m === 5) add(dstr(y, m, 28), 1980, 'Werkgever Acme B.V.', `Vakantiegeld ${y}`, { iban: 'NL44INGB0001234567' });
  add(dstr(y, m, 1), -1050, 'Woonbron', `Huur ${M} ${y} woning`, { code: 'ei', iban: 'NL11ABNA0123456780' });
  add(dstr(y, m, 3), -between(118, 152), 'Eneco Consumenten B.V.', `Termijnbedrag ${M} klantnr 889${Math.floor(between(100, 999))}`, { code: 'ei', iban: 'NL19ABNA0450129922' });
  if (m % 3 === 0) add(dstr(y, m, 8), -78.4, 'Vitens N.V.', `Voorschot water ${M}`, { code: 'ei' });
  add(dstr(y, m, 4), -54.95, 'KPN B.V.', `Factuur ${hex(8)} KPN Internet en TV`, { code: 'ei' });
  if (m <= 10) add(dstr(y, m, 28), -45.12, 'Gemeente Eindhoven', `Aanslag gemeentelijke belastingen ${y}`, { code: 'ei' });
  add(dstr(y, m, 2), -142.5, 'Zilveren Kruis Zorgverzekeringen', `Premie ${M} polis 7788${Math.floor(between(10, 99))}`, { code: 'ei' });
  add(dstr(y, m, 2), -23.8, 'Centraal Beheer Schade', 'Premie inboedel en aansprakelijkheid', { code: 'ei' });
  add(dstr(y, m, 5), -13.99, 'Netflix International B.V.', 'Netflix', { code: 'ei' });
  add(dstr(y, m, 12), -10.99, 'Spotify AB', 'Spotify Premium', { code: 'ei' });
  add(dstr(y, m, 9), -2.99, 'Apple Services', 'APPLE.COM/BILL iCloud', { code: 'id' });
  add(dstr(y, m, 6), -29.99, 'Basic-Fit', `Lidmaatschap ${M}`, { code: 'ei' });
  add(dstr(y, m, 1), -2.95, 'Rabobank', 'Kosten Rabo BetaalPakket Basis', { code: 'tb' });
  add(dstr(y, m, 26), -250, 'Oranje spaarrekening', 'Maandelijks sparen', { iban: SAVINGS });
  for (let i = 0; i < 9; i++) pin(dstr(y, m, 1 + Math.floor(rnd() * 28)), -between(8, 95), pick(['Albert Heijn', 'Albert Heijn', 'Jumbo', 'Lidl', 'Plus', 'AH to go']), 'Eindhoven');
  for (let i = 0; i < 3; i++) pin(dstr(y, m, 1 + Math.floor(rnd() * 28)), -between(4, 22), pick(["Bakkerij 't Brood", 'Slagerij Wijnands', 'Bakker Bart']), 'Eindhoven');
  for (let i = 0; i < 4; i++) pin(dstr(y, m, 1 + Math.floor(rnd() * 28)), -between(12, 85), pick(['Restaurant De Gouden Leeuw', "Cafe 't Hoekje", 'Starbucks', 'Pizzeria Napoli', 'Eetcafe De Hoek']), pick(['Eindhoven', 'Utrecht', 'Breda']));
  add(dstr(y, m, 10 + Math.floor(rnd() * 8)), -between(14, 38), 'Thuisbezorgd.nl', `Bestelling ${Math.floor(between(1e6, 9e6))}`, { code: 'id' });
  for (let i = 0; i < 2; i++) pin(dstr(y, m, 1 + Math.floor(rnd() * 28)), -between(45, 75), pick(['Shell', 'Tango', 'BP']), 'Veldhoven');
  for (let i = 0; i < 3; i++) add(dstr(y, m, 1 + Math.floor(rnd() * 28)), -between(3.2, 18.6), 'NS Groep IZ NS Reizigers', `OV-chipkaart opwaarderen ${hex(5)}`, { code: 'id' });
  pin(dstr(y, m, 1 + Math.floor(rnd() * 28)), -between(9, 40), pick(['Kruidvat', 'Etos']), 'Eindhoven');
  if (rnd() < 0.7) pin(dstr(y, m, 1 + Math.floor(rnd() * 28)), -between(20, 140), pick(['HEMA', 'Action', 'Blokker']), 'Eindhoven');
  add(dstr(y, m, 14 + Math.floor(rnd() * 10)), -between(15, 160), pick(['bol.com', 'Zalando Payments GmbH', 'Coolblue B.V.']), `Order ${Math.floor(between(1e8, 9e8))}`, { code: 'id', iban: 'NL93ADYB0000000123' });
  if (rnd() < 0.5) add(dstr(y, m, 15), -between(35, 60), 'Kapper Jansen', 'Knippen', { code: 'bc' });
  add(dstr(y, m, 18), -50, 'Geldautomaat Eindhoven', `GEA NR:${hex(6)} ${dmy(dstr(y, m, 18))} 17:42 Geldopname`, { code: 'ga' });
  if (rnd() < 0.6) add(dstr(y, m, 20), -between(8, 45), 'AAB INZ TIKKIE', `Tikkie ID ${Math.floor(between(1e9, 9e9))}, ${pick(['pizza', 'verjaardagscadeau', 'bowlen', 'etentje'])}`, { code: 'id' });
  if (rnd() < 0.4) add(dstr(y, m, 21), between(10, 40), 'AAB INZ TIKKIE', `Tikkie ID ${Math.floor(between(1e9, 9e9))}, terugbetaling`, { code: 'id' });
  // Onbekende maar terugkerende tegenpartijen: hier leert de module van
  if (m % 2 === 0) pin(dstr(y, m, 11), -between(18, 32), 'Dierenspeciaalzaak De Kat', 'Eindhoven');
  add(dstr(y, m, 16), -between(60, 95), 'Dierenarts Dommelstreek', 'Consult en vaccinatie', { code: 'id' });
  if (m === 11) add(dstr(y, m, 9), -420, 'Loodgietersbedrijf Van Dijk', 'Factuur 2026-118 reparatie CV', { code: 'ov', iban: 'NL55RABO0111222333' });
  if (m === 7) add(dstr(y, m, 3), 85.5, 'Zalando Payments GmbH', 'Retour order 123456789', { code: 'id' });
  if (m === 7 || m === 8) add(dstr(y, m, 5), -between(600, 1100), 'Booking.com B.V.', `Reservering ${hex(8)} hotel Lissabon`, { code: 'id' });
  if (m === 3) add(dstr(y, m, 20), 612, 'Belastingdienst', 'Teruggaaf inkomstenbelasting', { iban: 'NL86INGB0002445588' });
}
for (let i = rows.length - 1; i >= 0; i--) if (rows[i].date > '2026-11-12') rows.splice(i, 1);
rows.sort((a, b) => a.date.localeCompare(b.date));
let bal = 240000;
const q = v => `"${String(v).replace(/"/g, '""')}"`;
const f = n => (n < 0 ? '-' : '+') + (Math.abs(n) / 100).toFixed(2).replace('.', ',');
const head = ['IBAN/BBAN', 'Munt', 'BIC', 'Volgnr', 'Datum', 'Rentedatum', 'Bedrag', 'Saldo na trn', 'Tegenrekening IBAN/BBAN', 'Naam tegenpartij', 'Naam uiteindelijke partij', 'Naam initiërende partij', 'BIC tegenpartij', 'Code', 'Batch ID', 'Transactiereferentie', 'Machtigingskenmerk', 'Incassant ID', 'Betalingskenmerk', 'Omschrijving-1', 'Omschrijving-2', 'Omschrijving-3', 'Reden retour', 'Oorspr bedrag', 'Oorspr munt', 'Koers'];
const out = [head.map(q).join(',')];
rows.forEach((r, i) => {
  bal += r.amount;
  const d = r.desc.match(/.{1,70}(\s|$)/g) || [''];
  out.push([IBAN, 'EUR', 'RABONL2U', i + 1, r.date, r.date, f(r.amount), f(bal).replace('+', ''), r.iban, r.payee, '', '', '', r.code, '', '', '', '', '', (d[0] || '').trim(), (d[1] || '').trim(), (d[2] || '').trim(), '', '', '', ''].map(q).join(','));
});
process.stdout.write(out.join('\n') + '\n');

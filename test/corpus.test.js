// Gelabeld corpus: realistische Rabobank-regels met de verwachte categorie.
// Doel: nauwkeurigheid meten en regressies in woordenboek/normalisatie vangen.
// Formaat: [payee, omschrijving, bedrag in centen, rabo-code, verwachte categorie-key | null]
//   null = mag NIET automatisch worden ingedeeld (zekerheid < 80%): persoon, onbekend of ambigu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Categorizer, AUTO_THRESHOLD } from '../src/categorizer.js';
import { DEFAULT_CATEGORIES } from '../src/db.js';

const cats = DEFAULT_CATEGORIES.map((c, i) => ({ id: i + 1, key: c[0], name: c[1], kind: c[2] }));
const keyOf = id => cats.find(c => c.id === id)?.key;
const cz = new Categorizer({ categories: cats });

const P = 'Pasvolgnr:012 03-10-2026 12:34 Transactie:A1B2C3 Term:XY12';
const CASES = [
  // --- supermarkten (typische pin-notatie) ---
  ['ALBERT HEIJN 1234 EINDHOVEN NLD', 'BEA, Apple Pay Albert Heijn 1234,PAS123 NR:CT123456, 03.10.26 12:34 Eindhoven', -4521, 'bc', 'groceries'],
  ['AH to go 5614', P, -349, 'bc', 'groceries'],
  ['Albert Heijn 1561', P, -8830, 'ba', 'groceries'],
  ['JUMBO FOODMARKT BREDA', P, -2399, 'bc', 'groceries'],
  ['Jumbo Veghel Hoofdstraat', P, -1180, 'bc', 'groceries'],
  ['LIDL NEDERLAND GMBH', P, -3120, 'ba', 'groceries'],
  ['Aldi Nederland B.V.', P, -2215, 'ba', 'groceries'],
  ['PLUS Van der Heijden', P, -4120, 'ba', 'groceries'],
  ['Dirk van den Broek 0455', P, -2750, 'ba', 'groceries'],
  ['Coop Supermarkt Elst', P, -1540, 'bc', 'groceries'],
  ['Spar Express Station Utrecht', P, -599, 'bc', 'groceries'],
  ['Hoogvliet Rotterdam', P, -6120, 'ba', 'groceries'],
  ['Picnic B.V.', 'Boodschappen bezorging', -7450, 'id', 'groceries'],
  ['Vomar Voordeelmarkt', P, -3310, 'bc', 'groceries'],
  ['Bakkerij Van Dijk', P, -845, 'bc', 'groceries'],
  ['Slagerij De Vries', P, -2180, 'bc', 'groceries'],
  ['Gall & Gall 2210', P, -2495, 'bc', 'groceries'],
  // --- horeca ---
  ['Thuisbezorgd.nl', 'Bestelling 4823912', -2850, 'id', 'dining'],
  ['MCDONALD S 0345 BREDA', P, -1075, 'bc', 'dining'],
  ['Burger King Utrecht CS', P, -945, 'bc', 'dining'],
  ['Starbucks Coffee 12345', P, -565, 'bc', 'dining'],
  ['Restaurant De Gouden Leeuw', P, -8700, 'bc', 'dining'],
  ['Pizzeria Napoli', P, -3250, 'bc', 'dining'],
  ['Uber Eats', 'Order', -2260, 'id', 'dining'],
  ['Domino S Pizza Zwolle', P, -2395, 'bc', 'dining'],
  // --- vervoer & auto ---
  ['NS GROEP IZ NS REIZIGERS', 'OV-chipkaart opwaarderen', -2000, 'id', 'transit'],
  ['NS Reizigers 0123', P, -1180, 'bc', 'transit'],
  ['GVB Amsterdam', P, -450, 'bc', 'transit'],
  ['Shell Veldhoven Noord', P, -6890, 'bc', 'fuel'],
  ['TANGO ZEELAND', P, -5410, 'bc', 'fuel'],
  ['BP Tankstation Oss', P, -4905, 'bc', 'fuel'],
  ['Fastned B.V.', 'Laadsessie', -1620, 'id', 'fuel'],
  ['Q-Park Nederland N.V.', P, -1320, 'bc', 'car'],
  ['ANWB', 'Lidmaatschap Wegenwacht', -11900, 'ei', 'car'],
  ['Kwik-Fit Eindhoven', P, -24500, 'bc', 'car'],
  // --- wonen, energie, telecom ---
  ['Woonbron', 'Huur november 2026', -105000, 'ei', 'rent'],
  ['Hypotheek ABN AMRO', 'Maandlast hypotheek', -132000, 'ei', 'rent'],
  ['Eneco Consumenten B.V.', 'Termijnbedrag november', -12400, 'ei', 'energy'],
  ['Vattenfall N.V.', 'Voorschot', -10500, 'ei', 'energy'],
  ['Essent Retail Energie', 'Klantnr 12345', -9800, 'ei', 'energy'],
  ['Vitens N.V.', 'Voorschot water', -2600, 'ei', 'water'],
  ['KPN B.V.', 'Factuur 1234 Internet en TV', -5495, 'ei', 'telecom'],
  ['Ziggo B.V.', 'Mijn Ziggo', -6900, 'ei', 'telecom'],
  ['Odido Netherlands B.V.', 'Mobiel abonnement', -2500, 'ei', 'telecom'],
  ['Gemeente Eindhoven', 'Aanslag gemeentelijke belastingen', -4512, 'ei', 'taxes'],
  ['Belastingdienst', 'Aanslag inkomstenbelasting', -64000, 'ov', 'taxes'],
  ['IKEA Eindhoven', P, -15900, 'bc', 'home'],
  ['Gamma Bouwmarkt', P, -4320, 'bc', 'home'],
  // --- zorg & verzekeringen ---
  ['Zilveren Kruis Zorgverzekeringen', 'Premie november', -14250, 'ei', 'healthins'],
  ['CZ Zorgverzekeraar', 'Premie', -13900, 'ei', 'healthins'],
  ['VGZ Zorgverzekeraar N.V.', 'Premie', -13100, 'ei', 'healthins'],
  ['Menzis Zorgverzekeraar', 'Premie', -14100, 'ei', 'healthins'],
  ['Apotheek Dommelstreek', P, -1245, 'bc', 'health'],
  ['Tandartspraktijk De Smile', 'Factuur controle', -6500, 'id', 'health'],
  ['Centraal Beheer', 'Premie inboedel', -2380, 'ei', 'insurance'],
  ['Nationale-Nederlanden', 'Premie aansprakelijkheid', -1560, 'ei', 'insurance'],
  ['Kruidvat 5821', P, -1299, 'bc', 'drugstore'],
  ['Etos Bv', P, -2145, 'bc', 'drugstore'],
  // --- abonnementen, shopping, vrije tijd ---
  ['Netflix International B.V.', 'Netflix', -1399, 'ei', 'subscriptions'],
  ['Spotify AB', 'Spotify Premium', -1099, 'ei', 'subscriptions'],
  ['Disney Plus', 'Abonnement', -999, 'ei', 'subscriptions'],
  ['Apple Services', 'APPLE.COM/BILL iCloud', -299, 'id', 'subscriptions'],
  ['Amazon Prime NL', 'Prime lidmaatschap', -499, 'ei', 'subscriptions'],
  ['Bol.com', 'Order 1234567', -2995, 'id', 'shopping'],
  ['Zalando Payments GmbH', 'Order', -8990, 'id', 'shopping'],
  ['Coolblue B.V.', 'Order', -49900, 'id', 'shopping'],
  ['HEMA 0345', P, -1895, 'bc', 'shopping'],
  ['Action 1234', P, -2450, 'bc', 'shopping'],
  ['Pathe Eindhoven', P, -2400, 'bc', 'leisure'],
  ['Efteling Recreatie', 'Tickets', -9800, 'id', 'leisure'],
  ['Booking.com B.V.', 'Reservering hotel', -45000, 'id', 'travel'],
  ['KLM', 'Vlucht', -32000, 'id', 'travel'],
  ['Transavia', 'Boeking', -18000, 'id', 'travel'],
  ['Basic-Fit', 'Lidmaatschap', -2999, 'ei', 'sports'],
  ['Rode Kruis', 'Donatie', -1000, 'ei', 'gifts'],
  // --- bank, sparen, beleggen, contant ---
  ['Rabobank', 'Kosten Rabo BetaalPakket Basis', -295, 'tb', 'bank'],
  ['Oranje spaarrekening', 'Maandelijks sparen', -25000, 'ov', 'transfer'],
  ['DEGIRO', 'Storting', -50000, 'id', 'invest'],
  ['Geldautomaat Eindhoven', 'GEA NR:S1B2C3 03.10.26 17:42 Geldopname', -5000, 'ga', 'cash'],
  // --- inkomen ---
  ['Werkgever Acme B.V.', 'Salaris november 2026', 315000, 'ov', 'salary'],
  ['Stichting Pensioenfonds', 'Loonbetaling oktober', 290000, 'ov', 'salary'],
  ['UWV', 'Uitkering', 120000, 'ov', 'benefits'],
  ['Belastingdienst Toeslagen', 'Zorgtoeslag', 12800, 'ov', 'benefits'],
  ['DUO Studiefinanciering', 'Studiefinanciering', 31000, 'ov', 'benefits'],
  // --- valkuilen: mag NIET automatisch worden ingedeeld ---
  ['J. de Vries', 'terugbetaling etentje', 2500, 'id', null],
  ['Dirk Jansen', 'Tikkie bedankt', -1500, 'id', null],
  ['Ben Peters', 'cadeau', -2000, 'ov', 'gifts'],   // voornaam 'Ben' is geen merk; de omschrijving zegt cadeau
  ['Max Bakker', 'borrel', -1250, 'id', null],
  ['Plus Ultra Consultancy', 'factuur', -50000, 'ov', null],
  ['Mevr. A. Hendriks', 'huishoudelijke hulp', -4000, 'ov', null],
  ['Dirk Jansen', 'bedankt voor gisteren', -1500, 'id', null],      // voornaam is geen supermarkt
  ['Spar & Zn Beheer BV', 'factuur', -9000, 'ov', null],
  ['Coop. Bouw Eindhoven', 'factuur', -12000, 'ov', null],
  ['Action Sports Club', 'contributie', -3000, 'ov', null],
  ['AAB INZ TIKKIE', 'Tikkie ID 1234567, pizza', -1800, 'id', null],
  ['Onbekende Winkel BV', P, -2399, 'bc', null],
  ['Café de Kroeg', P, -1850, 'bc', null],       // generiek 'cafe': alleen suggestie
  ['Hotel Zeezicht', 'verblijf', -21000, 'ov', null], // generiek 'hotel': alleen suggestie
  ['Garage Peters', 'onderhoud', -35000, 'ov', null],  // generiek 'garage': alleen suggestie
  ['PayPal Europe S.a.r.l.', 'Betaling aan Webshop', -3500, 'id', null],
  ['Mollie Payments', 'Webshop', -2900, 'id', null],
];

test('corpus: juiste categorie voor bekende partijen, geen valse zekerheid bij ambigue', () => {
  const fails = []; let right = 0, sure = 0;
  for (const [payee, description, amount, code, expected] of CASES) {
    const r = cz.classify({ payee, description, amount, code, counter_iban: '' });
    const got = r ? keyOf(r.category_id) : null, conf = r?.confidence ?? 0;
    const autoGot = conf >= AUTO_THRESHOLD - 0.001 ? got : null; // wat de gebruiker zonder review zou zien
    const ok = expected === null ? autoGot === null : got === expected && conf >= AUTO_THRESHOLD - 0.001;
    if (ok) right++; else fails.push(`${payee} [${description.slice(0, 30)}] verwacht=${expected} kreeg=${got} (${conf.toFixed(2)}, ${r?.source})`);
    if (autoGot) sure++;
  }
  const acc = right / CASES.length;
  console.log(`  corpus: ${right}/${CASES.length} goed (${Math.round(acc * 100)}%), automatisch ingedeeld: ${sure}`);
  if (fails.length) console.log('  missers:\n   - ' + fails.join('\n   - '));
  assert.ok(acc >= 0.97, `nauwkeurigheid ${Math.round(acc * 100)}% < 97%`);
});

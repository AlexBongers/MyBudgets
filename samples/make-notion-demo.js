// Maakt samples/notion-demo.zip: een fictieve Notion-export ("Markdown & CSV") van een budget-app,
// op basis van dezelfde transacties als samples/rabobank-demo.csv, met Notion-achtige notaties en eigen categorienamen.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseRabobank } from '../src/rabobank.js';
import { writeZip } from '../src/zip.js';

const txs = parseRabobank(readFileSync(new URL('./rabobank-demo.csv', import.meta.url), 'utf8'));
const MND = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const CAT = [[/woonbron|huur/i, 'Wonen'], [/eneco|vattenfall/i, 'Energie'], [/vitens/i, 'Water'], [/kpn/i, 'Internet & TV'], [/gemeente/i, 'Belastingen'], [/zilveren|centraal beheer/i, 'Verzekeringen'],
  [/netflix|spotify|apple/i, 'Abonnementen'], [/basic-fit/i, 'Sport'], [/albert|jumbo|lidl|plus|ah to go|bakkerij|slager|bakker/i, 'Boodschappen'], [/thuisbezorgd|restaurant|cafe|starbucks|pizzeria|eetcafe/i, 'Uit eten'],
  [/shell|tango|bp /i, 'Benzine'], [/ns groep/i, 'Openbaar vervoer'], [/kruidvat|etos|kapper/i, 'Drogisterij'], [/hema|action|blokker|bol|zalando|coolblue/i, 'Winkelen'], [/booking/i, 'Vakantie'],
  [/dierenarts|dierenspeciaal/i, 'Huisdieren'], [/spaarrekening/i, 'Sparen'], [/geldautomaat/i, 'Contant'], [/salaris|werkgever/i, 'Salaris'], [/belastingdienst/i, 'Terugontvangen belasting']];
const id = '0123456789abcdef0123456789abcdef';
const q = v => `"${String(v).replace(/"/g, '""')}"`;
const longDate = d => `${+d.slice(8)} ${MND[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const rows = [['Naam', 'Datum', 'Bedrag', 'Type', 'Categorie', 'Rekening', 'Notities', 'Created time'].map(q).join(',')];
for (const t of txs) {
  const cat = (CAT.find(([re]) => re.test(t.payee + ' ' + t.description)) || [0, 'Overig'])[1];
  const eur = (Math.abs(t.amount) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  rows.push([t.payee, longDate(t.date), '€' + eur, t.amount < 0 ? 'Uitgave' : 'Inkomsten', cat, 'Betaalrekening', '', 'November 1, 2026 9:00 AM'].map(q).join(','));
}
const budgets = ['Categorie,Budget', 'Boodschappen,"€450,00"', 'Uit eten,"€150,00"', 'Benzine,"€120,00"', 'Abonnementen,"€40,00"', 'Winkelen,"€100,00"', 'Huisdieren,"€60,00"'].join('\n');
const zip = writeZip({
  [`Export-0001/Uitgaven ${id}_all.csv`]: '\uFEFF' + rows.join('\n'), [`Export-0001/Uitgaven ${id}.csv`]: '\uFEFF' + rows.slice(0, 20).join('\n'),
  [`Export-0001/Maandbudgetten ${id.replace(/0/g, '1')}.csv`]: budgets, [`Export-0001/Uitgaven/Albert Heijn 9 nov ${id}.md`]: '# Albert Heijn\n\nDatum: 9 november 2026\n',
});
writeFileSync(new URL('./notion-demo.zip', import.meta.url), zip);
console.log(`samples/notion-demo.zip: ${rows.length - 1} transacties, ${zip.length} bytes`);

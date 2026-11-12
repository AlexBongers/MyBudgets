// Prestatiemeting op een grote dataset: node --no-warnings scripts/bench.js [aantal]
import { openDb, importTransactions } from '../src/db.js';
import { createApi } from '../src/service.js';

const N = Number(process.argv[2]) || 60000;
const db = openDb(':memory:');
const api = createApi(db);
const shops = ['Albert Heijn', 'Jumbo', 'Lidl', 'Shell', 'NS Groep', 'Thuisbezorgd', 'Bol.com', 'Kruidvat', 'Action', 'Restaurant Het Hoekje', 'Onbekende Winkel', 'Café De Kroeg', 'Hema'];
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const txs = [];
for (let i = 0; i < N; i++) {
  const acc = ['NL01RABO0000000001', 'NL02RABO0000000002', 'NL03RABO0000000003'][i % 3];
  const d = new Date(Date.UTC(2021, 0, 1) + Math.floor(rnd() * 5 * 365) * 864e5).toISOString().slice(0, 10);
  const shop = shops[Math.floor(rnd() * shops.length)] + ' ' + (1000 + Math.floor(rnd() * 9000));
  const amount = Math.round((rnd() < 0.04 ? 1 : -1) * (200 + rnd() * 12000));
  txs.push({ date: d, amount, payee: shop, description: 'Pasvolgnr:012 ' + d, account: acc, counter_iban: '', code: 'bc', seq: i, balance: null, key: `${acc}|${i}|${d}|${amount}` });
}
const time = async (label, fn) => { const t = performance.now(); const r = await fn(); console.log(label.padEnd(28), String(Math.round(performance.now() - t)).padStart(6), 'ms'); return r; };
await time(`import ${N}`, () => importTransactions(db, txs));
await time('dashboard', () => api('GET', '/api/dashboard?month=2025-06'));
await time('dashboard (2e keer)', () => api('GET', '/api/dashboard?month=2025-06'));
await time('report 12 mnd', () => api('GET', '/api/report?months=12&month=2025-06'));
await time('report 24 mnd', () => api('GET', '/api/report?months=24&month=2025-06'));
await time('recurring', () => api('GET', '/api/recurring'));
await time('review', () => api('GET', '/api/review'));
await time('transactions (maand)', () => api('GET', '/api/transactions?month=2025-06'));
await time('transactions (alles, q)', () => api('GET', '/api/transactions?q=jumbo'));
await time('search', () => api('GET', '/api/search?q=albert'));
await time('detail categorie', () => api('GET', '/api/detail?category=10&months=12&month=2025-06'));
await time('budget', () => api('GET', '/api/budget?month=2025-06'));
await time('recategorize (alles)', () => api('POST', '/api/recategorize', {}));
const one = db.prepare('SELECT id FROM transactions LIMIT 1').get();
await time('indelen 1 transactie', () => api('PATCH', '/api/transactions/' + one.id, { category_id: 10 }));

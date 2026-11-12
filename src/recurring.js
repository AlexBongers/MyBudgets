// Detectie van terugkerende betalingen (abonnementen, vaste lasten).
const day = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const addDays = (d, n) => new Date((day(d) + Math.round(n)) * 864e5).toISOString().slice(0, 10);

const FREQS = [
  { name: 'wekelijks', lo: 6, hi: 8, tol: 1.5, min: 4, perMonth: 30.44 / 7, amt: 0.2 },
  { name: 'maandelijks', lo: 27, hi: 34, tol: 5, min: 3, perMonth: 1, amt: 0.35 },
  { name: 'per kwartaal', lo: 85, hi: 97, tol: 10, min: 2, perMonth: 1 / 3, amt: 0.35 },
  { name: 'jaarlijks', lo: 350, hi: 380, tol: 20, min: 2, perMonth: 1 / 12, amt: 0.35 },
];

export function detectRecurring(rows, latestDate) {
  const groups = new Map();
  for (const r of rows) { if (!r.merchant) continue; (groups.get(r.merchant) || groups.set(r.merchant, []).get(r.merchant)).push(r); }
  const out = [];
  for (const [merchant, list] of groups) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    if (list.length < 2) continue;
    const gaps = []; for (let i = 1; i < list.length; i++) gaps.push(day(list[i].date) - day(list[i - 1].date));
    const useful = gaps.filter(g => g >= 3); // meerdere betalingen op één dag samenvoegen we niet
    if (!useful.length) continue;
    const med = median(useful);
    const f = FREQS.find(f => med >= f.lo && med <= f.hi);
    if (!f || list.length < f.min) continue;
    const devs = useful.map(g => Math.abs(g - med));
    const goodGaps = devs.filter(d => d <= f.tol).length / devs.length;
    if (goodGaps < 0.7) continue;
    const amts = list.map(r => -r.amount), am = median(amts);
    const goodAmt = amts.filter(a => Math.abs(a - am) <= am * f.amt).length / amts.length;
    if (goodAmt < 0.7) continue;
    const last = list[list.length - 1];
    const spread = Math.max(...amts) - Math.min(...amts);
    const next = addDays(last.date, med);
    const active = day(latestDate) - day(last.date) <= med * 1.6;
    // categorie = meest voorkomende
    const cc = new Map(); list.forEach(r => cc.set(r.category_id, (cc.get(r.category_id) || 0) + 1));
    const category_id = [...cc.entries()].sort((a, b) => b[1] - a[1])[0][0];
    out.push({
      merchant, name: last.payee, frequency: f.name, count: list.length, amount: Math.round(last.amount < 0 ? -last.amount : am),
      median: Math.round(am), variable: spread > am * 0.05, last: last.date, next, active, category_id,
      monthly: Math.round(am * f.perMonth), since: list[0].date,
    });
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || b.monthly - a.monthly);
}

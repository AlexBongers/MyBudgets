// Inzichten: zoekt patronen in alle transacties (seizoenen, verschuivingen, gewoontes, eenmalige uitgaven,
// contant geld, achteraf betalen, retouren, prijsstijgingen van vaste lasten, …) en maakt er bevindingen van.
// Alles wordt live berekend uit de database; er staan geen persoonlijke gegevens in de code.
// Bedragen zijn gehele centen. Overboekingen tussen eigen rekeningen tellen nergens mee.
import { detectRecurring } from './recurring.js';
import { addMonths, dayNum } from './util.js';
import { displayName } from './normalize.js';

const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = (a, f = x => x) => a.reduce((t, x) => t + f(x), 0);
const eur = c => (c < 0 ? '−' : '') + '€ ' + Math.round(Math.abs(c) / 100).toLocaleString('nl-NL');
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const monthLabel = ym => `${MONTHS[+ym.slice(5, 7) - 1].slice(0, 3)} ${ym.slice(0, 4)}`;
const listNl = a => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' en ' + a[a.length - 1]);

const CASH_RE = /\b(geldmaat|geldautomaat|geldopname|atm)\b/i;
const BNPL_RE = /\b(klarna|riverty|afterpay|billink|in3|payin3|tinka|spraypay|capayable|pay later)\b/i;
// Voorvoegsels van betaalterminals ("BCK*Jumbo", "CCV*Winkel", "SumUp *Kapper"): zelfde winkel, andere schrijfwijze
const TERMINAL_PREFIX = /^(bck|ccv|sumup|zettle|izettle|iz|sq|tmc|pay|payu|mollie|adyen|buckaroo)\s+/;
// Bekende merken met meerdere schrijfwijzen op het afschrift
const ALIASES = [[/^(amzn|amazon)/, 'amazon'], [/^(ah|albert heijn)\b/, 'albert heijn'], [/^bol\b/, 'bol'], [/^(ns|ns groep|ns reizigers)\b/, 'ns']];
const SHOP_KEYS = new Set(['groceries', 'dining', 'drugstore', 'fuel', 'shopping', 'cash', 'transit', 'leisure', 'travel']);
const TAX_RE = /belasting|gemeente|waterschap|cjib|duo\b/i;
// Leesbare naam voor in een zin: zonder terminalvoorvoegsel, webadres, landcode en dubbele plaatsnaam
export function niceName(payee) {
  let s = displayName(payee).replace(/^(bck|ccv|sumup|zettle)\s*\*\s*/i, '').replace(/\b(www\.)?[a-z0-9-]+\.(nl|com|eu|de|be)\S*/gi, m => m.replace(/^www\./i, '').replace(/\.(nl|com|eu|de|be).*$/i, ''));
  s = s.replace(/\s+(NLD|LUX|DEU|BEL|GBR|IRL|FRA|ESP|USA)$/i, '').replace(/\s+via\s+.*$/i, '').replace(/\s+/g, ' ').trim();
  const w = s.split(' '), out = []; for (const x of w) if (!out.length || out[out.length - 1].toLowerCase() !== x.toLowerCase()) out.push(x);
  s = out.join(' ');
  if (/^amzn|^amazon/i.test(s)) s = 'Amazon';
  return s || String(payee || '');
}

export function computeInsights(db) {
  const rows = db.prepare(`SELECT t.id, t.date, t.ym, t.amount, t.payee, t.merchant, t.description, t.category_id cat,
      c.kind, c.name cname, c.icon, c.color, c.key
    FROM tl t LEFT JOIN categories c ON c.id=t.category_id WHERE COALESCE(c.kind,'')<>'transfer' ORDER BY t.date`).all();
  if (!rows.length) return { enough: false, reason: 'Nog geen transacties.' };
  for (const r of rows) r.exp = r.kind ? r.kind === 'expense' : r.amount < 0;        // uitgave of inkomen (zonder categorie: op teken)

  // ---- periode: alleen volledige maanden ----
  const lastDate = rows[rows.length - 1].date, firstYm = rows[0].ym;
  const end = +lastDate.slice(8) >= 25 ? lastDate.slice(0, 7) : addMonths(lastDate.slice(0, 7), -1);
  const months = []; for (let m = firstYm; m <= end; m = addMonths(m, 1)) months.push(m);
  if (months.length < 3) return { enough: false, reason: 'Inzichten verschijnen zodra er minstens drie volledige maanden aan transacties zijn.' };
  const inPeriod = rows.filter(r => r.ym <= end);
  const span = Math.min(12, months.length);   // vergelijkingsvenster: laatste 12 maanden tegenover de 12 daarvoor (zelfde seizoenen)
  const L = months.slice(-Math.min(12, months.length)), Lset = new Set(L);
  const cmpL = new Set(months.slice(-span)), cmpP = new Set(months.slice(-2 * span, -span));
  const hasPrev = months.length >= 24;
  const cats = new Map(); for (const r of rows) if (r.cat && !cats.has(r.cat)) cats.set(r.cat, { id: r.cat, name: r.cname, icon: r.icon, color: r.color, key: r.key });
  const catOf = id => cats.get(id) || { id: null, name: 'Zonder categorie', icon: '❔', color: '#9a958a' };

  // ---- merken: schrijfwijzen van dezelfde winkel samenvoegen ----
  const byMerchant = new Map();
  for (const r of inPeriod) { const k = r.merchant || '?'; (byMerchant.get(k) || byMerchant.set(k, []).get(k)).push(r); }
  const domCat = list => { const c = new Map(); list.forEach(r => c.set(r.cat, (c.get(r.cat) || 0) + 1)); return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]; };
  const brandOf = new Map(), firstWordGroups = new Map();
  for (const [m, list] of byMerchant) {
    const stripped = m.replace(TERMINAL_PREFIX, ''), alias = ALIASES.find(([re]) => re.test(stripped));
    if (alias) { brandOf.set(m, alias[1]); continue; }
    const fw = stripped.split(' ')[0];
    const gk = fw + '|' + domCat(list);
    if (list.length >= 5 && fw.length >= 4) { (firstWordGroups.get(gk) || firstWordGroups.set(gk, []).get(gk)).push(m); brandOf.set(m, gk); }
    else brandOf.set(m, stripped);
  }
  for (const r of rows) r.brand = brandOf.get(r.merchant || '?') ?? r.merchant;
  const brandName = new Map();
  { const cnt = new Map();
    for (const r of inPeriod) { const k = r.brand + '\u0000' + niceName(r.payee); cnt.set(k, (cnt.get(k) || 0) + 1); }
    const best = new Map(); for (const [k, n] of cnt) { const [b, name] = k.split('\u0000'); if (!best.has(b) || best.get(b)[1] < n) best.set(b, [name, n]); }
    for (const [b, [name]] of best) brandName.set(b, name); }
  const byBrand = new Map(); for (const r of inPeriod) (byBrand.get(r.brand) || byBrand.set(r.brand, []).get(r.brand)).push(r);

  // ---- vaste lasten (hele historie) ----
  const recRows = inPeriod.filter(r => r.exp && r.amount < 0 && r.merchant).map(r => ({ merchant: r.merchant, payee: r.payee, date: r.date, amount: r.amount, category_id: r.cat }));
  const recurring = detectRecurring(recRows, lastDate);
  const recurringMerchants = new Set(recurring.map(r => r.merchant));

  // ---- contant geld ----
  const isCash = r => r.amount < 0 && r.exp && (r.key === 'cash' || CASH_RE.test(r.payee));
  // ---- eenmalige grote uitgaven: groot bedrag én geen terugkerend bedrag bij die tegenpartij ----
  const monthExp = Object.fromEntries(months.map(m => [m, 0])), monthInc = Object.fromEntries(months.map(m => [m, 0]));
  for (const r of inPeriod) { if (r.exp) monthExp[r.ym] -= r.amount; else monthInc[r.ym] += r.amount; }
  const medExp = median(months.map(m => monthExp[m]));
  const oneOffMin = Math.max(75000, Math.round(medExp * 0.12));
  const isOneOff = r => {
    if (!r.exp || -r.amount < oneOffMin || isCash(r)) return false;
    const a = -r.amount, similar = (byMerchant.get(r.merchant || '?') || []).filter(x => x.amount < 0 && Math.abs(-x.amount - a) <= a * 0.35).length;
    return similar < 3;
  };
  for (const r of inPeriod) r.oneOff = isOneOff(r);
  const monthBase = Object.fromEntries(months.map(m => [m, 0]));
  for (const r of inPeriod) if (r.exp && !r.oneOff) monthBase[r.ym] -= r.amount;

  // ---- totalen ----
  const tot = set => { const ms = months.filter(m => set.has(m)); const income = sum(ms, m => monthInc[m]), expenses = sum(ms, m => monthExp[m]), base = sum(ms, m => monthBase[m]); return { income, expenses, base, net: income - expenses, months: ms.length }; };
  const cur = tot(Lset), prevSet = new Set(months.slice(-24, -12)), prev = prevSet.size === 12 ? tot(prevSet) : null;
  const findings = [];
  const add = (f) => findings.push(f);

  // ---- 1. jaren en voortschrijdend saldo ----
  const years = [...new Set(months.map(m => m.slice(0, 4)))].map(y => {
    const ms = months.filter(m => m.startsWith(y));
    const income = sum(ms, m => monthInc[m]), expenses = sum(ms, m => monthExp[m]);
    return { year: y, months: ms.length, income, expenses, net: income - expenses, rate: income > 0 ? pct(income - expenses, income) : null };
  });
  const rolling = months.map((m, i) => (i >= 11 ? { month: m, value: sum(months.slice(i - 11, i + 1), x => monthInc[x] - monthExp[x]) } : null)).filter(Boolean);
  if (prev) {
    const d = cur.net - prev.net;
    add({ id: 'trend', section: 'trend', tone: cur.net >= 0 ? 'good' : 'warn', impact: Math.abs(d) + Math.abs(cur.net),
      kicker: 'Laatste 12 maanden', value: (cur.net > 0 ? '+' : '') + eur(cur.net),
      title: cur.net >= 0 ? (prev.net < 0 ? 'Van rood naar zwart' : 'Je houdt geld over') : 'Er gaat meer uit dan er binnenkomt',
      text: `Inkomsten ${eur(cur.income)}, uitgaven ${eur(cur.expenses)}. In de twaalf maanden daarvoor was het saldo ${(prev.net > 0 ? '+' : '') + eur(prev.net)}: een verschil van ${eur(Math.abs(d))}${d > 0 ? ' in je voordeel' : ''}.` });
    if (prev.income > 0 && prev.expenses > 0) {
      const gi = pct(cur.income - prev.income, prev.income), ge = pct(cur.base - prev.base, prev.base);
      if (Math.abs(gi - ge) >= 4) add({ id: 'growth', section: 'trend', tone: gi > ge ? 'good' : 'warn', impact: Math.abs((gi - ge) / 100 * cur.income),
        kicker: 'Inkomen tegenover uitgaven', value: `${gi > 0 ? '+' : ''}${gi}% / ${ge > 0 ? '+' : ''}${ge}%`,
        title: gi > ge ? 'Je inkomen groeit harder dan je uitgaven' : 'Je uitgaven groeien harder dan je inkomen',
        text: `Inkomsten ${gi >= 0 ? 'stegen' : 'daalden'} ${Math.abs(gi)}% in een jaar; de gewone uitgaven (zonder eenmalige posten) ${ge >= 0 ? 'stegen' : 'daalden'} ${Math.abs(ge)}%.` });
    }
  }

  // ---- 2. seizoenspatroon per kalendermaand ----
  const season = Array.from({ length: 12 }, (_, i) => {
    const ms = months.filter(m => +m.slice(5, 7) === i + 1);
    return { month: i + 1, name: MONTHS[i], n: ms.length, income: ms.length ? Math.round(sum(ms, m => monthInc[m]) / ms.length) : 0,
      expenses: ms.length ? Math.round(sum(ms, m => monthBase[m]) / ms.length) : 0 };
  });
  season.forEach(s => { s.net = s.income - s.expenses; });
  const medInc = median(months.map(m => monthInc[m]));
  const bonus = months.length >= 12 ? season.filter(s => s.n >= 1 && medInc > 0 && s.income >= medInc * 1.25) : [];
  const negCal = season.filter(s => s.n && s.net < 0);
  if (bonus.length && bonus.length <= 4 && months.length >= 12) {
    const extra = sum(L.filter(m => bonus.some(b => b.month === +m.slice(5, 7))), m => Math.max(0, monthInc[m] - medInc));
    const without = cur.net - extra;
    add({ id: 'season', section: 'season', tone: without < 0 ? 'warn' : 'info', impact: extra,
      kicker: 'Seizoenspatroon', value: eur(extra),
      title: `${(t => t[0].toUpperCase() + t.slice(1))(listNl(bonus.map(b => b.name)))} ${bonus.length > 1 ? 'dragen' : 'draagt'} het jaar`,
      text: `In ${listNl(bonus.map(b => b.name))} komt er duidelijk meer binnen (vakantiegeld, eindejaarsuitkering of teruggaaf): samen ${eur(extra)} extra in het laatste jaar. ${without < 0 ? `Zonder die extra's zou je ${eur(-without)} tekortkomen` : `Ook zonder die extra's houd je ${eur(without)} over`}; in ${negCal.length} van de 12 kalendermaanden geef je gemiddeld meer uit dan er binnenkomt.` });
  }

  // ---- 3. verschuivingen per categorie (zonder eenmalige posten) ----
  let shifts = [];
  if (hasPrev) {
    const agg = new Map();
    for (const r of inPeriod) {
      if (!r.exp || r.oneOff || r.key === 'cash' || CASH_RE.test(r.payee)) continue; const inL = cmpL.has(r.ym), inP = cmpP.has(r.ym); if (!inL && !inP) continue;
      const a = agg.get(r.cat) || agg.set(r.cat, { cur: 0, prev: 0 }).get(r.cat); if (inL) a.cur -= r.amount; else a.prev -= r.amount;
    }
    shifts = [...agg.entries()].map(([id, a]) => ({ ...catOf(id), cur: a.cur, prev: a.prev, diff: a.cur - a.prev }))
      .filter(s => Math.abs(s.diff) >= 30000 * span / 12 && Math.abs(s.diff) >= Math.max(Math.abs(s.prev), Math.abs(s.cur)) * 0.15)
      .sort((a, b) => b.diff - a.diff);
    const up = shifts.filter(s => s.diff > 0), down = shifts.filter(s => s.diff < 0).reverse();
    if (up.length) add({ id: 'shift-up', section: 'shifts', tone: 'warn', impact: up[0].diff, kicker: 'Grootste stijger', value: '+' + eur(up[0].diff),
      title: `${up[0].icon} ${up[0].name} kost je meer`,
      text: `${eur(up[0].cur)} in de laatste ${span} maanden tegen ${eur(up[0].prev)} in de ${span} daarvoor${up[1] ? `. Ook gestegen: ${listNl(up.slice(1, 4).map(s => `${s.name} (+${eur(s.diff)})`))}` : ''}.` });
    if (down.length) add({ id: 'shift-down', section: 'shifts', tone: 'good', impact: -down[0].diff * 0.8, kicker: 'Grootste daler', value: eur(down[0].diff),
      title: `${down[0].icon} ${down[0].name} kost je minder`,
      text: `${eur(down[0].cur)} in de laatste ${span} maanden tegen ${eur(down[0].prev)} daarvoor${down[1] ? `. Ook gedaald: ${listNl(down.slice(1, 4).map(s => `${s.name} (${eur(s.diff)})`))}` : ''}.` });
  }

  // ---- 4. eenmalige grote uitgaven ----
  const offs = inPeriod.filter(r => r.oneOff).map(r => ({ id: r.id, date: r.date, payee: niceName(r.payee), amount: -r.amount, ...pickCat(catOf(r.cat)) }));
  const oneOffYears = years.map(y => ({ year: y.year, total: sum(offs.filter(o => o.date.startsWith(y.year)), o => o.amount), n: offs.filter(o => o.date.startsWith(y.year)).length }));
  const offL = offs.filter(o => Lset.has(o.date.slice(0, 7))), offLtot = sum(offL, o => o.amount);
  const baseMonthly = Math.round(median(L.map(m => monthBase[m])));
  if (offs.length) add({ id: 'oneoff', section: 'oneoff', tone: 'info', impact: offLtot * 0.6 + 1,
    kicker: 'Eenmalig tegenover gewoon', value: eur(baseMonthly) + '/mnd',
    title: 'Je gewone maand zonder uitschieters',
    text: `Zonder eenmalige grote uitgaven (vanaf ${eur(oneOffMin)}) geef je ${eur(baseMonthly)} per maand uit. Het laatste jaar kwam daar ${eur(offLtot)} aan uitschieters bovenop (${offL.length} ${offL.length === 1 ? 'post' : 'posten'})${offL.length ? `, de grootste: ${offL.sort((a, b) => b.amount - a.amount)[0].payee} (${eur(offL[0].amount)})` : ''}.` });

  // ---- 5. contant geld ----
  const cashRows = inPeriod.filter(isCash);
  const cash = { total: sum(cashRows, r => -r.amount), n: cashRows.length, last12: sum(cashRows.filter(r => Lset.has(r.ym)), r => -r.amount),
    years: years.map(y => ({ year: y.year, total: sum(cashRows.filter(r => r.date.startsWith(y.year)), r => -r.amount), n: cashRows.filter(r => r.date.startsWith(y.year)).length })) };
  if (cash.total >= 50000 && cash.n >= 3) add({ id: 'cash', section: 'cash', tone: 'info', impact: cash.total / Math.max(1, months.length / 12),
    kicker: 'Contant geld', value: eur(cash.total),
    title: 'Opgenomen en daarna onzichtbaar',
    text: `In ${monthsText(months.length)} is ${eur(cash.total)} contant opgenomen (${cash.n} keer, gemiddeld ${eur(cash.total / cash.n)}), waarvan ${eur(cash.last12)} in het laatste jaar. Waar dat geld aan opging is in geen enkel overzicht terug te zien.` });

  // ---- 6. gewoontes: hoe vaak en hoe duur ----
  const habitAgg = new Map();
  for (const r of inPeriod) {
    if (!r.exp || r.amount >= 0 || r.oneOff || !r.cat || isCash(r) || recurringMerchants.has(r.merchant)) continue;
    const inL = cmpL.has(r.ym), inP = hasPrev && cmpP.has(r.ym); if (!inL && !inP) continue;
    const h = habitAgg.get(r.cat) || habitAgg.set(r.cat, { n: 0, tot: 0, pn: 0, ptot: 0 }).get(r.cat);
    if (inL) { h.n++; h.tot -= r.amount; } else { h.pn++; h.ptot -= r.amount; }
  }
  const habits = [...habitAgg.entries()].filter(([, h]) => h.n >= span * 4).map(([id, h]) => {
    const perMonth = h.n / span, ticket = h.tot / h.n, pPerMonth = h.pn / span, pTicket = h.pn ? h.ptot / h.pn : 0;
    // verandering ontleed: vaker/minder vaak × bon, en duurdere/goedkopere bon × aantal
    const byFreq = Math.round((perMonth - pPerMonth) * pTicket), byTicket = Math.round((ticket - pTicket) * perMonth);
    const yearsS = years.map(y => { const rs = inPeriod.filter(r => r.cat === id && r.exp && r.amount < 0 && !r.oneOff && r.date.startsWith(y.year)); return { year: y.year, perMonth: +(rs.length / y.months).toFixed(1), ticket: rs.length ? Math.round(sum(rs, r => -r.amount) / rs.length) : 0, monthly: Math.round(sum(rs, r => -r.amount) / y.months) }; });
    return { ...catOf(id), perMonth: +perMonth.toFixed(1), ticket: Math.round(ticket), monthly: Math.round(h.tot / span), prevPerMonth: +pPerMonth.toFixed(1), prevTicket: Math.round(pTicket), prevMonthly: Math.round(h.ptot / span), byFreq, byTicket, hasPrev: h.pn >= span * 2, years: yearsS };
  }).sort((a, b) => b.monthly - a.monthly).slice(0, 5);
  const h0 = habits.find(h => h.hasPrev && Math.abs(h.monthly - h.prevMonthly) >= 2500);
  if (h0) {
    const d = h0.monthly - h0.prevMonthly, main = Math.abs(h0.byFreq) >= Math.abs(h0.byTicket) ? 'freq' : 'ticket';
    add({ id: 'habit', section: 'habits', tone: d > 0 ? 'warn' : 'good', impact: Math.abs(d) * 12, kicker: 'Gewoonte', value: `${String(h0.perMonth).replace('.', ',')}× per maand`,
      title: `${h0.icon} ${h0.name}: ${main === 'freq' ? (h0.perMonth > h0.prevPerMonth ? 'je gaat vaker' : 'je gaat minder vaak') : (h0.ticket > h0.prevTicket ? 'de bon wordt hoger' : 'de bon wordt lager')}`,
      text: `Nu ${String(h0.perMonth).replace('.', ',')} keer per maand voor gemiddeld ${eur(h0.ticket)} (${eur(h0.monthly)} per maand); eerder ${String(h0.prevPerMonth).replace('.', ',')} keer voor ${eur(h0.prevTicket)}. Van het verschil van ${d > 0 ? '+' : ''}${eur(d)} per maand komt ${eur(Math.abs(h0.byFreq))} door ${h0.byFreq >= 0 ? 'vaker' : 'minder vaak'} gaan en ${eur(Math.abs(h0.byTicket))} door ${h0.byTicket >= 0 ? 'een hogere' : 'een lagere'} bon.` });
  } else if (habits[0]) add({ id: 'habit', section: 'habits', tone: 'info', impact: habits[0].monthly, kicker: 'Gewoonte', value: `${String(habits[0].perMonth).replace('.', ',')}× per maand`,
    title: `${habits[0].icon} ${habits[0].name} is je meest voorkomende uitgave`, text: `Gemiddeld ${String(habits[0].perMonth).replace('.', ',')} keer per maand voor ${eur(habits[0].ticket)} per keer: ${eur(habits[0].monthly)} per maand.` });

  // ---- 7. waar het geld heen gaat: grootste winkels (schrijfwijzen samengevoegd) ----
  const variable = inPeriod.filter(r => r.exp && r.amount < 0 && Lset.has(r.ym) && !r.oneOff && !isCash(r) && !recurringMerchants.has(r.merchant));
  const varTot = sum(variable, r => -r.amount);
  const brandAgg = new Map(); for (const r of variable) { const b = brandAgg.get(r.brand) || brandAgg.set(r.brand, { n: 0, total: 0, cat: r.cat }).get(r.brand); b.n++; b.total -= r.amount; }
  const merchants = [...brandAgg.entries()].map(([b, v]) => ({ name: brandName.get(b) || b, merchant: (byBrand.get(b) || [])[0]?.merchant || b, n: v.n, total: v.total, avg: Math.round(v.total / v.n), share: pct(v.total, varTot), ...pickCat(catOf(v.cat)) }))
    .filter(m => m.n >= 4).sort((a, b) => b.total - a.total).slice(0, 10);
  const top3 = sum(merchants.slice(0, 3), m => m.total);
  if (merchants.length >= 5 && varTot > 0) add({ id: 'merchants', section: 'merchants', tone: 'info', impact: top3 * 0.25, kicker: 'Waar het heen gaat', value: pct(top3, varTot) + '%',
    title: `Drie adressen, ${pct(top3, varTot)}% van je vrije uitgaven`,
    text: `${listNl(merchants.slice(0, 3).map(m => `${m.name} (${eur(m.total)}, ${m.n}×)`))}. Vrije uitgaven zijn alles behalve vaste lasten, contant geld en eenmalige posten: ${eur(varTot)} in het laatste jaar.` });

  // ---- 8. kleine uitgaven ----
  const smallRows = variable.filter(r => -r.amount < 2500);
  const small = { n: smallRows.length, total: sum(smallRows, r => -r.amount), perMonth: Math.round(smallRows.length / L.length), share: pct(sum(smallRows, r => -r.amount), varTot) };
  { const a = new Map(); for (const r of smallRows) { const b = a.get(r.brand) || a.set(r.brand, { n: 0, total: 0 }).get(r.brand); b.n++; b.total -= r.amount; }
    small.top = [...a.entries()].map(([b, v]) => ({ name: brandName.get(b) || b, n: v.n, total: v.total })).sort((x, y) => y.total - x.total).slice(0, 5); }
  if (small.n >= 60 && small.total >= 60000) add({ id: 'small', section: 'small', tone: 'info', impact: small.total * 0.3, kicker: 'Kleine bedragen', value: eur(small.total),
    title: `${small.n} keer minder dan € 25`,
    text: `Ongeveer ${small.perMonth} kleine betalingen per maand. Elk apart valt niet op, samen is het ${eur(small.total)} per jaar (${small.share}% van je vrije uitgaven)${small.top[0] ? `, het vaakst bij ${listNl(small.top.slice(0, 3).map(t => t.name))}` : ''}.` });

  // ---- 9. achteraf betalen ----
  const bnplRows = inPeriod.filter(r => r.exp && r.amount < 0 && BNPL_RE.test(r.payee + ' ' + (r.description || '')));
  const bnpl = { total: sum(bnplRows, r => -r.amount), n: bnplRows.length, last12: sum(bnplRows.filter(r => Lset.has(r.ym)), r => -r.amount), n12: bnplRows.filter(r => Lset.has(r.ym)).length,
    years: years.map(y => ({ year: y.year, total: sum(bnplRows.filter(r => r.date.startsWith(y.year)), r => -r.amount), n: bnplRows.filter(r => r.date.startsWith(y.year)).length })) };
  if (bnpl.n12 >= 4 && bnpl.last12 >= 30000) add({ id: 'bnpl', section: 'bnpl', tone: 'warn', impact: bnpl.last12 * 0.5, kicker: 'Achteraf betalen', value: eur(bnpl.last12),
    title: `${bnpl.n12} aankopen via Klarna, Riverty en dergelijke`,
    text: `In het laatste jaar ging ${eur(bnpl.last12)} via achteraf-betaaldiensten (${eur(bnpl.total)} in totaal). Die betalingen komen weken na de aankoop, waardoor een maand duurder uitvalt dan hij voelde, en in je overzicht staat de dienst in plaats van de winkel.` });

  // ---- 10. retouren: terugbetalingen van winkels waar je ook koopt ----
  const retAgg = new Map();
  for (const [b, list] of byBrand) {
    const buys = list.filter(r => r.exp && r.amount < 0 && Lset.has(r.ym)), refs = list.filter(r => r.exp && r.amount > 0 && Lset.has(r.ym));
    if (buys.length < 2 || !refs.length) continue;
    { const am = buys.map(r => -r.amount), mean = sum(am) / am.length, sd = Math.sqrt(sum(am, x => (x - mean) ** 2) / am.length);
      if (am.length >= 3 && sd / mean < 0.25) continue; }                             // vaste rekening (energie, verzekering): geen retour maar een verrekening
    const bought = sum(buys, r => -r.amount), returned = sum(refs, r => r.amount); if (returned > bought) continue;
    retAgg.set(b, { name: brandName.get(b) || b, bought, returned, n: refs.length, cat: domCat(buys) });
  }
  const retList = [...retAgg.values()].sort((a, b) => b.returned - a.returned);
  const returns = { returned: sum(retList, r => r.returned), bought: sum(retList, r => r.bought), n: sum(retList, r => r.n), top: retList.slice(0, 6).map(r => ({ name: r.name, bought: r.bought, returned: r.returned, n: r.n, ratio: pct(r.returned, r.bought) })) };
  if (returns.returned >= 30000 && returns.n >= 5) add({ id: 'returns', section: 'returns', tone: 'info', impact: returns.returned * 0.3, kicker: 'Retouren', value: eur(returns.returned),
    title: `${pct(returns.returned, returns.bought)}% gaat weer terug`,
    text: `Bij winkels waar je iets terugstuurde kocht je voor ${eur(returns.bought)} en kreeg je ${eur(returns.returned)} terug (${returns.n} terugbetalingen). Het meest bij ${listNl(returns.top.slice(0, 3).map(t => `${t.name} (${t.ratio}%)`))}. Tot de terugbetaling binnen is, staat dat geld voor niets uit.` });

  // ---- 11. vaste lasten: prijsstijgingen, gestopt en nieuw ----
  const endDay = dayNum(lastDate);
  const creep = [];
  for (const r of recurring.filter(x => x.active && x.count >= 6 && !TAX_RE.test(x.name))) {
    const list = (byMerchant.get(r.merchant) || []).filter(x => x.amount < 0 && x.exp).map(x => -x.amount);
    const first = median(list.slice(0, 3)), last = median(list.slice(-3)), d = last - first;
    if (first <= 0 || Math.abs(d) < Math.max(200, first * 0.05)) continue;
    const perYear = r.median > 0 ? r.monthly / r.median * 12 : 12;
    creep.push({ name: niceName(r.name), merchant: r.merchant, from: Math.round(first), to: Math.round(last), pct: pct(d, first), yearly: Math.round(d * perYear), since: r.since, frequency: r.frequency, ...pickCat(catOf(r.category_id)) });
  }
  creep.sort((a, b) => b.yearly - a.yearly);
  const creepUp = creep.filter(c => c.yearly > 0), creepTot = sum(creepUp, c => c.yearly);
  const fixedMonthly = sum(recurring.filter(r => r.active), r => r.monthly);
  if (creepUp.length && creepTot >= 12000) add({ id: 'creep', section: 'fixed', tone: 'warn', impact: creepTot, kicker: 'Vaste lasten', value: '+' + eur(creepTot) + '/jr',
    title: `${creepUp.length} vaste last${creepUp.length === 1 ? ' is' : 'en zijn'} duurder geworden`,
    text: `Samen ${eur(creepTot)} per jaar meer dan toen ze begonnen. De grootste: ${listNl(creepUp.slice(0, 3).map(c => `${c.name} (${eur(c.from)} → ${eur(c.to)})`))}. Je vaste lasten zijn nu ${eur(fixedMonthly)} per maand.` });
  // Gestopt en nieuw: rekeningen (hooguit een paar betalingen per maand) die maandenlang liepen en ophielden, of net begonnen zijn.
  // Losser dan de vaste-lastenherkenning, zodat ook bedragen die langzaam veranderen (kinderopvang) meetellen.
  const ended = [], started = [];
  for (const [b, list] of byBrand) {
    const pays = list.filter(r => r.exp && r.amount < 0 && !r.oneOff && !isCash(r)); if (pays.length < 4) continue;
    const first = pays[0].date, last = pays[pays.length - 1].date, gone = endDay - dayNum(last);
    const active = new Map(); for (const r of pays) active.set(r.ym, (active.get(r.ym) || 0) + 1);
    if (pays.length / active.size > 2.2 || SHOP_KEYS.has(pays[0].key)) continue;      // winkel, geen rekening
    const info = { name: brandName.get(b) || niceName(pays[0].payee), merchant: pays[pays.length - 1].merchant, since: first, last, ...pickCat(catOf(domCat(pays))) };
    if (gone >= 60 && gone <= 550 && pays.length >= 6) {
      const from = addMonths(last.slice(0, 7), -11), recent = pays.filter(r => r.ym >= from), am = new Set(recent.map(r => r.ym)).size;
      const monthly = Math.round(sum(recent, r => -r.amount) / 12);
      if (am >= 8 && monthly >= 7500) ended.push({ ...info, monthly });
    } else if (gone < 60 && Lset.has(first.slice(0, 7)) && first.slice(0, 7) > months[0]) {
      const ms = months.filter(m => m >= first.slice(0, 7)), monthly = Math.round(sum(pays, r => -r.amount) / ms.length);
      if (active.size >= Math.max(3, ms.length * 0.6) && monthly >= 2500) started.push({ ...info, monthly });
    }
  }
  ended.sort((x, y) => y.monthly - x.monthly); started.sort((x, y) => y.monthly - x.monthly); ended.splice(6); started.splice(6);
  if (ended.length) {
    const freed = sum(ended, e => e.monthly), took = sum(started, s => s.monthly);
    add({ id: 'freed', section: 'fixed', tone: took >= freed ? 'warn' : 'good', impact: freed * 12 * 0.7, kicker: 'Vrijgekomen geld', value: eur(freed) + '/mnd',
      title: `${ended[0].name} is gestopt`,
      text: `${listNl(ended.slice(0, 3).map(e => `${e.name} (${eur(e.monthly)} per maand, tot ${monthLabel(e.last.slice(0, 7))})`))} ${ended.length > 1 ? 'lopen' : 'loopt'} niet meer: ${eur(freed)} per maand minder vaste lasten.${started.length ? ` Daar kwam ${eur(took)} per maand aan nieuwe vaste lasten voor terug, zoals ${listNl(started.slice(0, 2).map(s => s.name))}.` : ''} Kijk bij de verschuivingen waar de rest heen ging.` });
  }

  // ---- 12. dag van de week ----
  const wd = Array.from({ length: 7 }, (_, i) => ({ day: ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'][i], idx: i, total: 0, n: 0 }));
  for (const r of variable) { const d = new Date(r.date + 'T12:00:00Z').getUTCDay(); wd[d].total -= r.amount; wd[d].n++; }
  const weeks = L.length * 30.44 / 7; wd.forEach(d => { d.perDay = Math.round(d.total / weeks); d.ticket = d.n ? Math.round(d.total / d.n) : 0; });
  const weekdays = [...wd.slice(1), wd[0]];
  const peak = [...wd].sort((a, b) => b.perDay - a.perDay)[0], low = [...wd].filter(d => d.n).sort((a, b) => a.perDay - b.perDay)[0];
  const DAYN = { zo: 'zondag', ma: 'maandag', di: 'dinsdag', wo: 'woensdag', do: 'donderdag', vr: 'vrijdag', za: 'zaterdag' };
  if (variable.length >= 100 && low && peak.perDay >= low.perDay * 1.4) add({ id: 'weekday', section: 'weekday', tone: 'info', impact: (peak.perDay - low.perDay) * 20, kicker: 'Weekritme', value: eur(peak.perDay),
    title: `${DAYN[peak.day][0].toUpperCase() + DAYN[peak.day].slice(1)} is je duurste dag`,
    text: `Op een gemiddelde ${DAYN[peak.day]} geef je ${eur(peak.perDay)} uit aan vrije uitgaven, op ${DAYN[low.day]} ${eur(low.perDay)}. Let op: de bank boekt pinbetalingen van het weekend soms op maandag.` });

  // ---- 13. verwachting voor dit jaar ----
  let forecast = null;
  const curYear = end.slice(0, 4), ytdMonths = months.filter(m => m.startsWith(curYear)), remaining = 12 - +end.slice(5, 7);
  if (months.length >= 14 && remaining > 0 && ytdMonths.length >= 2) {
    const ytd = sum(ytdMonths, m => monthInc[m] - monthExp[m]);
    const hist = m => { const ms = months.filter(x => +x.slice(5, 7) === m && !x.startsWith(curYear)).slice(-3); return ms.length ? sum(ms, x => monthInc[x] - monthBase[x]) / ms.length : null; };
    const rest = []; for (let m = +end.slice(5, 7) + 1; m <= 12; m++) rest.push({ month: m, name: MONTHS[m - 1], net: hist(m) });
    if (rest.every(r => r.net !== null)) {
      // historische maanden schalen met de groei van dit jaar ten opzichte van dezelfde maanden vorig jaar blijft bewust achterwege: eenvoud boven schijnprecisie
      const expected = Math.round(ytd + sum(rest, r => r.net));
      forecast = { year: curYear, ytd, expected, rest: rest.map(r => ({ ...r, net: Math.round(r.net) })) };
      add({ id: 'forecast', section: 'trend', tone: expected >= 0 ? 'good' : 'warn', impact: Math.abs(expected) * 0.5, kicker: `Verwachting ${curYear}`, value: (expected > 0 ? '+' : '') + eur(expected),
        title: expected >= 0 ? `Op koers om ${curYear} positief af te sluiten` : `${curYear} dreigt in de min te eindigen`,
        text: `Tot en met ${MONTHS[+end.slice(5, 7) - 1]} staat het jaar op ${(ytd > 0 ? '+' : '') + eur(ytd)}. Als de resterende ${remaining} maand${remaining === 1 ? '' : 'en'} verlopen zoals in eerdere jaren (zonder eenmalige uitschieters), eindig je rond ${(expected > 0 ? '+' : '') + eur(expected)}.` });
    }
  }

  // ---- 14. kwaliteit van de gegevens ----
  const uncat = inPeriod.filter(r => !r.cat);
  const uncatIn = new Map(); for (const r of uncat) if (r.amount > 0) { const k = r.brand; const a = uncatIn.get(k) || uncatIn.set(k, { name: brandName.get(k) || displayName(r.payee), merchant: r.merchant, total: 0, n: 0 }).get(k); a.total += r.amount; a.n++; }
  const quality = { uncategorized: uncat.length, share: pct(uncat.length, inPeriod.length), inflow: sum(uncat.filter(r => r.amount > 0), r => r.amount), outflow: sum(uncat.filter(r => r.amount < 0), r => -r.amount),
    topInflow: [...uncatIn.values()].filter(x => x.total >= 100000).sort((a, b) => b.total - a.total).slice(0, 4) };
  if (quality.inflow >= 200000 && quality.topInflow.length) add({ id: 'quality', section: 'quality', tone: 'info', impact: quality.inflow * 0.08, kicker: 'Betrouwbaarheid', value: eur(quality.inflow),
    title: 'Bijschrijvingen zonder categorie tellen als inkomen',
    text: `${eur(quality.inflow)} aan bijschrijvingen heeft geen categorie, vooral van ${listNl(quality.topInflow.slice(0, 2).map(t => t.name))}. Zijn dat stortingen van je eigen andere rekeningen, zet ze dan op een overboekings-categorie: nu maken ze je inkomen en je saldo hoger dan ze zijn.` });

  findings.sort((a, b) => b.impact - a.impact);
  return {
    enough: true,
    period: { from: months[0], to: end, months: months.length, lastDate, span, hasPrev },
    summary: { cur, prev, baseMonthly, fixedMonthly, oneOffMin },
    findings: findings.map(({ impact, ...f }) => f),
    years, rolling, monthly: months.map(m => ({ month: m, income: monthInc[m], expenses: monthExp[m], base: monthBase[m] })),
    season, bonusMonths: bonus.map(b => b.month), forecast,
    shifts: shifts.map(s => ({ id: s.id, name: s.name, icon: s.icon, color: s.color, cur: s.cur, prev: s.prev, diff: s.diff })),
    oneOffs: { min: oneOffMin, years: oneOffYears, list: [...offs].sort((a, b) => b.amount - a.amount).slice(0, 12) },
    cash, habits, merchants, variableTotal: varTot, small, bnpl, returns,
    fixed: { monthly: fixedMonthly, creep: creep.slice(0, 10), ended, started },
    weekdays, quality,
  };
}
const pickCat = c => ({ category: c.name, icon: c.icon, color: c.color, category_id: c.id });
const monthsText = n => (n >= 24 ? `${Math.round(n / 12 * 10) / 10} jaar`.replace('.', ',') : `${n} maanden`);

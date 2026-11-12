// Kleine SVG-grafieken zonder dependencies. Kleuren via CSS-variabelen, dus donker/licht werkt vanzelf.
'use strict';
function niceMax(v) { if (v <= 0) return 100; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
const axisEur = c => { const e = c / 100; return e >= 1000 ? (e / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 }) + 'k' : String(Math.round(e)); };

function barChart(trend, selected) {
  const W = 680, H = 230, pad = { l: 42, r: 6, t: 10, b: 24 };
  const max = niceMax(Math.max(1, ...trend.flatMap(t => [t.income, t.expenses])));
  const bw = (W - pad.l - pad.r) / trend.length, y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Inkomsten en uitgaven per maand">`;
  for (let i = 0; i <= 4; i++) { const v = max * i / 4; s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${axisEur(v)}</text>`; }
  trend.forEach((t, i) => {
    const x = pad.l + i * bw, w = bw * 0.34, sel = t.month === selected;
    if (sel) s += `<rect x="${x + 2}" y="${pad.t}" width="${bw - 4}" height="${H - pad.t - pad.b}" fill="var(--accent-soft)" rx="6"/>`;
    s += `<g data-month="${t.month}" style="cursor:default"><rect x="${x}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" fill="transparent"/>`
      + `<rect x="${x + bw * 0.12}" y="${y(t.income)}" width="${w}" height="${Math.max(0, y(0) - y(t.income))}" fill="var(--good)" rx="3"><title>${monthName(t.month)}: inkomsten ${eur(t.income)}</title></rect>`
      + `<rect x="${x + bw * 0.12 + w + 2}" y="${y(t.expenses)}" width="${w}" height="${Math.max(0, y(0) - y(t.expenses))}" fill="var(--bad)" rx="3" opacity=".85"><title>${monthName(t.month)}: uitgaven ${eur(t.expenses)}</title></rect></g>`
      + `<text x="${x + bw / 2}" y="${H - 7}" text-anchor="middle" ${sel ? 'style="fill:var(--text);font-weight:600"' : ''}>${monthShort(t.month)}</text>`;
  });
  return s + '</svg>';
}

function donut(items, size = 170) {
  const total = items.reduce((a, b) => a + b.value, 0);
  if (!total) return '<div class="empty">Geen uitgaven</div>';
  const R = 74, r = 50, cx = 80, cy = 80; let a0 = -Math.PI / 2, paths = '';
  const P = (rad, a) => [(cx + rad * Math.cos(a)).toFixed(2), (cy + rad * Math.sin(a)).toFixed(2)];
  items.forEach(it => {
    const sweep = Math.min((it.value / total) * Math.PI * 2, Math.PI * 2 - 0.001), a1 = a0 + sweep - (items.length > 1 ? 0.018 : 0), large = sweep > Math.PI ? 1 : 0;
    const [x0, y0] = P(R, a0), [x1, y1] = P(R, a1), [x2, y2] = P(r, a1), [x3, y3] = P(r, a0);
    paths += `<path data-cat="${it.id ?? ''}" d="M${x0} ${y0}A${R} ${R} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r} ${r} 0 ${large} 0 ${x3} ${y3}Z" fill="${it.color}"><title>${esc(it.name)}: ${eur(it.value)} (${pct(it.value, total)}%)</title></path>`;
    a0 += (it.value / total) * Math.PI * 2;
  });
  return `<svg viewBox="0 0 160 160" width="${size}" height="${size}" style="flex:none">${paths}<text x="80" y="76" text-anchor="middle" style="font-size:9.5px">Uitgaven</text><text x="80" y="93" text-anchor="middle" style="font-size:14px;font-weight:700;fill:var(--text)">${eur0(total)}</text></svg>`;
}

// Cumulatieve uitgaven per dag: deze maand vs vorige maand, met budgetlijn.
function lineChart({ month, prev, days }, budget, projection) {
  const W = 680, H = 210, pad = { l: 42, r: 8, t: 10, b: 22 };
  const max = niceMax(Math.max(1, ...month, ...prev, budget || 0, projection || 0) * 1.02);
  const x = d => pad.l + (W - pad.l - pad.r) * (d / (days - 1)), y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const path = a => a.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Cumulatieve uitgaven per dag">`;
  for (let i = 0; i <= 4; i++) { const v = max * i / 4; s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${axisEur(v)}</text>`; }
  [1, 8, 15, 22, days].forEach(d => { s += `<text x="${x(d - 1)}" y="${H - 5}" text-anchor="middle">${d}</text>`; });
  if (budget) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(budget)}" y2="${y(budget)}" stroke="var(--warn)" stroke-dasharray="5 4"/><text x="${W - pad.r}" y="${y(budget) - 5}" text-anchor="end" style="fill:var(--warn)">Budget ${eur0(budget)}</text>`;
  s += `<path d="${path(prev)}" fill="none" stroke="var(--faint)" stroke-width="2" stroke-dasharray="4 4"/>`;
  if (projection && month.length) s += `<path d="M${x(month.length - 1).toFixed(1)} ${y(month[month.length - 1]).toFixed(1)}L${x(days - 1).toFixed(1)} ${y(projection).toFixed(1)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="2 4" opacity=".7"/>`;
  s += `<path d="${path(month)}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>`;
  if (month.length) s += `<circle cx="${x(month.length - 1)}" cy="${y(month[month.length - 1])}" r="4" fill="var(--accent)"/>`;
  return s + '</svg>';
}

function sparkline(values, w = 90, h = 24, color = 'var(--accent)') {
  const max = Math.max(1, ...values), n = values.length;
  const pts = values.map((v, i) => `${(i / (n - 1) * (w - 2) + 1).toFixed(1)},${(h - 2 - (h - 4) * v / max).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function progressBar(spent, budget) {
  const p = budget ? Math.min(100, Math.max(0, spent / budget * 100)) : 0;
  const col = !budget ? 'var(--faint)' : spent > budget ? 'var(--bad)' : spent > budget * .85 ? 'var(--warn)' : 'var(--good)';
  return `<div class="bar"><i style="width:${p}%;background:${col}"></i></div>`;
}

// Staafdiagram met één reeks (bijv. uitgaven per maand voor één categorie). Klikbaar via data-month.
function monthBars(monthly, color = 'var(--accent)') {
  const W = 680, H = 200, pad = { l: 42, r: 6, t: 10, b: 24 };
  const max = niceMax(Math.max(1, ...monthly.map(m => Math.abs(m.value))));
  const bw = (W - pad.l - pad.r) / monthly.length, y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const avg = monthly.reduce((a, m) => a + m.value, 0) / monthly.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  for (let i = 0; i <= 4; i++) { const v = max * i / 4; s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${axisEur(v)}</text>`; }
  monthly.forEach((m, i) => {
    const x = pad.l + i * bw, h = Math.max(0, y(0) - y(Math.max(0, m.value)));
    s += `<g data-month="${m.month}"><rect x="${x}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" fill="transparent"/><rect x="${x + bw * 0.15}" y="${y(Math.max(0, m.value))}" width="${bw * 0.7}" height="${h}" fill="${color}" rx="4"><title>${monthName(m.month)}: ${eur(m.value)}</title></rect></g><text x="${x + bw / 2}" y="${H - 7}" text-anchor="middle">${monthShort(m.month)}</text>`;
  });
  if (avg > 0) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(avg)}" y2="${y(avg)}" stroke="var(--warn)" stroke-dasharray="5 4"/><text x="${W - pad.r}" y="${y(avg) - 4}" text-anchor="end" style="fill:var(--warn)">gem. ${eur0(avg)}</text>`;
  return s + '</svg>';
}

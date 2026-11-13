// Kleine SVG-grafieken zonder dependencies. Kleuren via CSS-variabelen, dus donker/licht werkt vanzelf.
'use strict';
function niceMax(v) { if (v <= 0) return 100; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
const axisEur = c => { const e = c / 100; return e >= 1000 ? (e / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 }) + 'k' : String(Math.round(e)); };

// Staaf met afgeronde bovenkant en vlakke voet op de basislijn
function barPath(x, y, w, h, r = 4) {
  if (h <= 0 || w <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x.toFixed(1)} ${(y + h).toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)}H${(x + w - r).toFixed(1)}Q${(x + w).toFixed(1)} ${y.toFixed(1)} ${(x + w).toFixed(1)} ${(y + r).toFixed(1)}V${(y + h).toFixed(1)}Z`;
}
const gridLine = (x1, x2, y, solid) => `<line x1="${x1}" x2="${x2}" y1="${y}" y2="${y}" stroke="${solid ? 'var(--line-strong)' : 'var(--line)'}" ${solid ? '' : 'stroke-dasharray="2 4"'}/>`;
// Grafieken met assen tekenen op hun werkelijke breedte W (via chartBox), zodat labels altijd ~11px zijn.
const chartH = (W, max, min = 160) => Math.round(Math.min(max, Math.max(min, W * 0.52)));
function barChart(trend, selected) { return chartBox(W => barSvg(trend, selected, W)); }
function barSvg(trend, selected, W) {
  const H = chartH(W, 230), pad = { l: 42, r: 6, t: 10, b: 24 };
  const max = niceMax(Math.max(1, ...trend.flatMap(t => [t.income, t.expenses])));
  const bw = (W - pad.l - pad.r) / trend.length, y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Inkomsten en uitgaven per maand">`;
  for (let i = 0; i <= 4; i++) { const v = max * i / 4; s += `${gridLine(pad.l, W - pad.r, y(v), !i)}<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${axisEur(v)}</text>`; }
  trend.forEach((t, i) => {
    const x = pad.l + i * bw, w = Math.min(18, bw * 0.34), sel = t.month === selected;
    if (sel) s += `<rect x="${x + 2}" y="${pad.t}" width="${bw - 4}" height="${H - pad.t - pad.b}" fill="var(--accent-soft)" rx="6"/>`;
    s += `<g data-month="${t.month}" style="cursor:default"><rect x="${x}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" fill="transparent"/>`
      + `<path d="${barPath(x + bw * 0.14, y(t.income), w, Math.max(0, y(0) - y(t.income)))}" fill="var(--inc)"><title>${monthName(t.month)}: inkomsten ${eur(t.income)}</title></path>`
      + `<path d="${barPath(x + bw * 0.14 + w + 2, y(t.expenses), w, Math.max(0, y(0) - y(t.expenses)))}" fill="var(--exp)"><title>${monthName(t.month)}: uitgaven ${eur(t.expenses)}</title></path></g>`
      + (bw >= 22 || sel || i % 2 === (trend.length - 1) % 2 ? `<text x="${x + bw / 2}" y="${H - 7}" text-anchor="middle" ${sel ? 'style="fill:var(--text);font-weight:600"' : ''}>${monthShort(t.month)}</text>` : '');
  });
  return s + '</svg>';
}

function donut(items, size = 170) {
  const total = items.reduce((a, b) => a + b.value, 0);
  if (!total) return '<div class="empty">Geen uitgaven</div>';
  const R = 74, r = 50, cx = 80, cy = 80; let a0 = -Math.PI / 2, paths = '';
  const P = (rad, a) => [(cx + rad * Math.cos(a)).toFixed(2), (cy + rad * Math.sin(a)).toFixed(2)];
  items.forEach(it => {
    const sweep = Math.min((it.value / total) * Math.PI * 2, Math.PI * 2 - 0.001), a1 = a0 + sweep, large = sweep > Math.PI ? 1 : 0;
    const [x0, y0] = P(R, a0), [x1, y1] = P(R, a1), [x2, y2] = P(r, a1), [x3, y3] = P(r, a0);
    paths += `<path data-cat="${it.id ?? ''}" d="M${x0} ${y0}A${R} ${R} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r} ${r} 0 ${large} 0 ${x3} ${y3}Z" fill="${it.color}" stroke="var(--card)" stroke-width="${items.length > 1 ? 2 : 0}" stroke-linejoin="round"><title>${esc(it.name)}: ${eur(it.value)} (${pct(it.value, total)}%)</title></path>`;
    a0 += (it.value / total) * Math.PI * 2;
  });
  return `<svg viewBox="0 0 160 160" width="${size}" height="${size}" style="flex:none">${paths}<text x="80" y="74" text-anchor="middle" style="font-size:9px">Uitgaven</text><text x="80" y="93" text-anchor="middle" style="font:600 17px var(--display);fill:var(--text);letter-spacing:-.02em">${eur0(total)}</text></svg>`;
}

// Cumulatieve uitgaven per dag: deze maand vs vorige maand, met budgetlijn.
function lineChart(data, budget, projection) { return chartBox(W => lineSvg(data, budget, projection, W)); }
function lineSvg({ month, prev, days }, budget, projection, W) {
  const H = chartH(W, 210), pad = { l: 42, r: 8, t: 10, b: 22 };
  const max = niceMax(Math.max(1, ...month, ...prev, budget || 0, projection || 0) * 1.02);
  const x = d => pad.l + (W - pad.l - pad.r) * (d / (days - 1)), y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const path = a => a.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Cumulatieve uitgaven per dag">`;
  for (let i = 0; i <= 4; i++) { const v = max * i / 4; s += `${gridLine(pad.l, W - pad.r, y(v), !i)}<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${axisEur(v)}</text>`; }
  [1, 8, 15, 22, days].forEach(d => { s += `<text x="${x(d - 1)}" y="${H - 5}" text-anchor="middle">${d}</text>`; });
  if (budget) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(budget)}" y2="${y(budget)}" stroke="var(--warn)" stroke-dasharray="5 4"/><text x="${W - pad.r}" y="${y(budget) - 5}" text-anchor="end" style="fill:var(--warn)">Budget ${eur0(budget)}</text>`;
  s += `<path d="${path(prev)}" fill="none" stroke="var(--faint)" stroke-width="2" stroke-dasharray="4 4"/>`;
  if (projection && month.length) s += `<path d="M${x(month.length - 1).toFixed(1)} ${y(month[month.length - 1]).toFixed(1)}L${x(days - 1).toFixed(1)} ${y(projection).toFixed(1)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="2 4" opacity=".7"/>`;
  s += `<path d="${path(month)}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>`;
  // onzichtbare raakpunten per dag voor tooltips (deze maand t.o.v. vorige maand)
  for (let i = 0; i < Math.max(month.length, 0); i++) s += `<circle cx="${x(i).toFixed(1)}" cy="${y(month[i]).toFixed(1)}" r="7" fill="transparent"><title>Dag ${i + 1}: ${eur(month[i])}${prev[i] != null ? ` · vorige maand ${eur(prev[i])}` : ''}</title></circle>`;
  if (month.length) s += `<circle cx="${x(month.length - 1)}" cy="${y(month[month.length - 1])}" r="5" fill="var(--accent)" stroke="var(--card)" stroke-width="2"/>`;
  return s + '</svg>';
}

function sparkline(values, w = 90, h = 24, color = 'var(--accent)') {
  const max = Math.max(1, ...values), n = values.length;
  const pts = values.map((v, i) => `${(i / (n - 1) * (w - 2) + 1).toFixed(1)},${(h - 2 - (h - 4) * v / max).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function progressBar(spent, budget) {
  const p = budget ? Math.min(100, Math.max(0, spent / budget * 100)) : 0;
  const col = !budget ? 'var(--faint)' : spent > budget ? 'var(--bad)' : spent > budget * .85 ? 'var(--warn)' : 'var(--accent)';
  return `<div class="bar"><i style="width:${p}%;background:${col}"></i></div>`;
}

// Staafdiagram met één reeks (bijv. uitgaven per maand voor één categorie). Klikbaar via data-month.
function monthBars(monthly, color = 'var(--accent)') { return chartBox(W => monthBarsSvg(monthly, color, W)); }
function monthBarsSvg(monthly, color, W) {
  const H = chartH(W, 200), pad = { l: 42, r: 6, t: 10, b: 24 };
  const max = niceMax(Math.max(1, ...monthly.map(m => Math.abs(m.value))));
  const bw = (W - pad.l - pad.r) / monthly.length, y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const avg = monthly.reduce((a, m) => a + m.value, 0) / monthly.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  for (let i = 0; i <= 4; i++) { const v = max * i / 4; s += `${gridLine(pad.l, W - pad.r, y(v), !i)}<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${axisEur(v)}</text>`; }
  monthly.forEach((m, i) => {
    const x = pad.l + i * bw, h = Math.max(0, y(0) - y(Math.max(0, m.value)));
    s += `<g data-month="${m.month}"><rect x="${x}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" fill="transparent"/><path d="${barPath(x + bw * 0.5 - Math.min(26, bw * 0.62) / 2, y(Math.max(0, m.value)), Math.min(26, bw * 0.62), h)}" fill="${color}"><title>${monthName(m.month)}: ${eur(m.value)}</title></rect></g>${bw >= 22 || i % 2 === (monthly.length - 1) % 2 ? `<text x="${x + bw / 2}" y="${H - 7}" text-anchor="middle">${monthShort(m.month)}</text>` : ''}`;
  });
  if (avg > 0) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(avg)}" y2="${y(avg)}" stroke="var(--warn)" stroke-dasharray="5 4"/><text x="${W - pad.r}" y="${y(avg) - 4}" text-anchor="end" style="fill:var(--warn)">gem. ${eur0(avg)}</text>`;
  return s + '</svg>';
}

// Lijn met vlak eronder, voor saldo-verloop. points: [{date, balance}] (op volgorde, ongelijke tussenpozen).
function areaChart(points) { return chartBox(W => areaSvg(points, W)); }
function areaSvg(points, W) {
  const H = chartH(W, 210), pad = { l: 46, r: 8, t: 10, b: 22 };
  const t0 = Date.parse(points[0].date), t1 = Date.parse(points.at(-1).date) || t0 + 1;
  let lo = Math.min(...points.map(p => p.balance)), hi = Math.max(...points.map(p => p.balance));
  const span = Math.max(1, hi - lo); lo -= span * 0.08; hi += span * 0.08;
  const x = d => pad.l + (W - pad.l - pad.r) * ((Date.parse(d) - t0) / Math.max(1, t1 - t0)), y = v => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)} ${y(p.balance).toFixed(1)}`).join('');
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Saldo-verloop">`;
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4; s += `${gridLine(pad.l, W - pad.r, y(v), !i)}<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${axisEur(v)}</text>`; }
  const seen = new Set(); let lastX = -99;
  points.forEach(p => { const mo = p.date.slice(0, 7), px = x(p.date); if (!seen.has(mo) && p.date.slice(8) <= '10') { seen.add(mo); if (px - lastX >= 30) { lastX = px; s += `<text x="${px}" y="${H - 5}" text-anchor="middle">${monthShort(mo)}</text>`; } } });
  const gid = 'ag' + Math.random().toString(36).slice(2, 7);
  s += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs><path d="${line}L${x(points.at(-1).date).toFixed(1)} ${y(lo)}L${x(points[0].date).toFixed(1)} ${y(lo)}Z" fill="url(#${gid})"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/>`;
  points.forEach(p => { s += `<circle cx="${x(p.date).toFixed(1)}" cy="${y(p.balance).toFixed(1)}" r="6" fill="transparent"><title>${fmtDate(p.date)}: ${eur(p.balance)}</title></circle>`; });
  const last = points.at(-1); s += `<circle cx="${x(last.date)}" cy="${y(last.balance)}" r="5" fill="var(--accent)" stroke="var(--card)" stroke-width="2"/>`;
  return s + '</svg>';
}

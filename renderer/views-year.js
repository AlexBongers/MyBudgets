'use strict';
// Jaaroverzicht: één jaar in één oogopslag, vergeleken met dezelfde periode van het jaar ervoor.
V.year = async () => {
  const d = await GET('/year' + (S.year ? '?year=' + S.year : ''));
  S.year = d.year;
  const t = d.totals, p = d.prevTotals, net = t.income - t.expenses, rate = t.income > 0 ? Math.round(net / t.income * 100) : null;
  const prevRate = p.income > 0 ? Math.round((p.income - p.expenses) / p.income * 100) : null;
  const active = d.months.filter(m => m.income || m.expenses), withExp = d.months.filter(m => m.expenses > 0);
  const hi = withExp.length ? withExp.reduce((a, b) => (b.expenses > a.expenses ? b : a)) : null, lo = withExp.length > 1 ? withExp.reduce((a, b) => (b.expenses < a.expenses ? b : a)) : null;
  const [ty, tm, td] = d.to.split('-').map(Number), monthsDone = d.partial ? Math.max(0.5, (tm - 1) + td / new Date(ty, tm, 0).getDate()) : 12; // verstreken maanden, voor het gemiddelde
  const totalCat = d.byCategory.reduce((a, c) => a + c.value, 0);
  const cmp = !d.prevComplete ? 'geen vergelijking: vorig jaar niet volledig' : d.partial ? `t/m ${fmtDate(d.to)} · ${deltaWord(d.year)}` : deltaWord(d.year);
  const m = render(`
    <div class="row between" style="margin-bottom:16px">
      <div class="row"><button class="icon-btn" id="yprev" ${d.years.includes(String(d.year - 1)) ? '' : 'disabled'} aria-label="Vorig jaar">‹</button><h2 style="margin:0;font-size:22px;text-transform:none;letter-spacing:-.01em;color:var(--text)">${d.year}</h2>
        <button class="icon-btn" id="ynext" ${d.years.includes(String(+d.year + 1)) ? '' : 'disabled'} aria-label="Volgend jaar">›</button>
        ${d.partial ? `<span class="tag blue">loopt nog — t/m ${fmtDate(d.to)}</span>` : ''}</div>
      <div class="seg" id="yseg">${[...d.years].reverse().map(y => `<button data-y="${y}" class="${y === d.year ? 'on' : ''}">${y}</button>`).join('')}</div>
    </div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card kpi"><h2>Inkomsten</h2><div class="v pos">${eur0(t.income)}</div><div class="sub">${d.prevComplete ? deltaChip(t.income, p.income, false) : ''}<span class="muted">${esc(cmp)}</span></div></div>
      <div class="card kpi"><h2>Uitgaven</h2><div class="v">${eur0(t.expenses)}</div><div class="sub">${d.prevComplete ? deltaChip(t.expenses, p.expenses, true) : ''}<span class="muted">gem. ${eur0(t.expenses / monthsDone)} per maand</span></div></div>
      <div class="card kpi"><h2>Over / tekort</h2><div class="v ${net >= 0 ? 'pos' : 'neg'}">${eurSigned(Math.round(net / 100) * 100).replace(/,00$/, '')}</div><div class="sub"><span class="muted">${d.prevComplete ? 'vorig jaar ' + eur0(p.income - p.expenses) : ''}</span></div></div>
      <div class="card kpi"><h2>Spaarquote</h2><div class="v">${rate !== null ? rate + '%' : '–'}</div><div class="sub"><span class="muted">${d.prevComplete && prevRate !== null ? 'vorig jaar ' + prevRate + '%' : `${d.txCount} transacties`}</span></div></div>
    </div>
    ${!d.txCount ? '<div class="card empty">Geen transacties in dit jaar.</div>' : `
    <div class="grid g21" style="margin-bottom:16px">
      <div class="card"><h2>Per maand <span class="right"><span class="dot" style="background:var(--good)"></span> inkomsten &nbsp;<span class="dot" style="background:var(--bad)"></span> uitgaven</span></h2>${barChart(d.months, null)}
        <div class="row small muted" style="gap:6px 18px;margin-top:6px">${hi ? `<span>Duurste maand: <b style="color:var(--text)">${monthName(hi.month)}</b> (${eur0(hi.expenses)})</span>` : ''}${lo ? `<span>Goedkoopste: <b style="color:var(--text)">${monthName(lo.month)}</b> (${eur0(lo.expenses)})</span>` : ''}${active.length ? `<span>Beste maand: <b style="color:var(--text)">${monthName(active.reduce((a, b) => (b.income - b.expenses > a.income - a.expenses ? b : a)).month)}</b></span>` : ''}</div></div>
      <div class="card"><h2>Inkomsten per bron</h2>${d.income.length ? d.income.slice(0, 6).map(i => `<div style="margin-bottom:10px" data-cat="${i.id ?? ''}"><div class="row between small"><span>${i.icon} ${esc(i.name)}</span><b>${eur0(i.value)}</b></div><div class="bar"><i style="width:${Math.max(2, i.value / t.income * 100)}%;background:${i.color}"></i></div></div>`).join('') : '<div class="empty">Geen inkomsten</div>'}</div>
    </div>
    <div class="grid g2" style="margin-bottom:16px">
      <div class="card"><h2>Uitgaven per categorie <span class="right muted">${d.prevComplete ? `t.o.v. ${d.year - 1}${d.partial ? ' (zelfde periode)' : ''}` : ''}</span></h2>
        <div class="row donut-row" style="gap:16px;align-items:flex-start;flex-wrap:nowrap">${donut(d.byCategory.slice(0, 12))}
        <div class="legend">${d.byCategory.slice(0, 10).map(c => `<div class="li" data-cat="${c.id ?? ''}"><span><i class="dot" style="background:${c.color}"></i> ${c.icon} ${esc(c.name)} <span class="faint small">${pct(c.value, totalCat)}%</span></span><span class="nowrap"><b>${eur0(c.value)}</b> ${d.prevComplete && c.prev && Math.abs(c.value - c.prev) > c.prev * 0.05 ? deltaChip(c.value, c.prev, true) : ''}</span></div>`).join('')}</div></div></div>
      <div class="card"><h2>Verloop per categorie <span class="right muted">jan – dec</span></h2><table>${d.byCategory.filter(c => d.catMonths[c.id]).map(c => `<tr data-cat="${c.id}" style="cursor:default"><td>${c.icon} ${esc(c.name)}</td><td>${sparkline(d.catMonths[c.id].slice(0, d.partial ? tm : 12), 110, 26, c.color)}</td><td class="num"><b>${eur0(c.value)}</b></td><td class="num muted small hide-c">${eur0(c.value / monthsDone)}/mnd</td></tr>`).join('') || '<tr><td class="empty">Geen data</td></tr>'}</table></div>
    </div>
    <div class="grid g2">
      <div class="card"><h2>Top tegenpartijen</h2><table>${d.topPayees.map(x => `<tr data-payee="${esc(x.merchant)}" style="cursor:default"><td>${x.icon} ${esc(x.payee)}</td><td class="muted small">${x.n}×</td><td class="num"><b>${eur0(x.value)}</b></td></tr>`).join('')}</table></div>
      <div class="card"><h2>Grootste uitgaven</h2><table>${d.biggest.map(x => `<tr data-tx="${x.id}" style="cursor:default"><td class="nowrap muted small">${fmtDay(x.date)}</td><td><div class="tx-name">${esc(x.payee)}</div><div class="small muted">${x.icon} ${esc(x.category)}</div></td><td class="num"><b>${eur0(x.value)}</b></td></tr>`).join('')}</table></div>
    </div>`}`);
  const go1 = y => { S.year = y; V.year(); };
  $('#yprev').onclick = () => go1(String(d.year - 1)); $('#ynext').onclick = () => go1(String(+d.year + 1));
  $('#yseg').addEventListener('click', e => { if (e.target.dataset.y) go1(e.target.dataset.y); });
  m.querySelectorAll('[data-month]').forEach(g => g.addEventListener('click', () => { S.month = g.dataset.month; go('dashboard'); }));
  m.querySelectorAll('[data-cat]').forEach(el => el.addEventListener('click', () => openCategory(el.dataset.cat ? +el.dataset.cat : null)));
  m.querySelectorAll('[data-payee]').forEach(el => el.addEventListener('click', () => openMerchant(el.dataset.payee)));
  m.querySelectorAll('[data-tx]').forEach(el => el.addEventListener('click', () => txDetail(+el.dataset.tx)));
};
const deltaWord = y => `t.o.v. ${y - 1}`;

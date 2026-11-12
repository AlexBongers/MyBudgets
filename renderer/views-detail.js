'use strict';
// Drill-down: één categorie of één tegenpartij, 12 maanden trend + onderdelen + recente transacties.
function openCategory(id) { if (!id) { S.txFilter = { category: 'none', all: true }; return go('transactions'); } S.detail = { category: id }; go('detail'); }
function openMerchant(key) { if (!key) return; S.detail = { merchant: key }; go('detail'); }

V.detail = async () => {
  const d = S.detail || {};
  const qs = new URLSearchParams({ month: S.month || '', months: S.detailMonths || 12 });
  if (d.category) qs.set('category', d.category); else qs.set('merchant', d.merchant);
  const r = await GET('/detail?' + qs);
  $('#title').textContent = r.title;
  const n = r.months.length, sharetotal = Math.max(1, r.total);
  const label = r.kind === 'income' || r.sign === 1 ? 'Ontvangen' : 'Uitgegeven';
  const m = render(`
    <div class="row between" style="margin-bottom:14px"><div class="row"><button class="btn sm" id="back">‹ Terug</button>
      <span class="chip" style="--c:${r.color}">${r.icon} ${esc(r.type === 'category' ? r.group : 'Tegenpartij')}</span>${r.first ? `<span class="muted small">sinds ${fmtDate(r.first)}</span>` : ''}</div>
      <div class="row"><div class="seg" id="dm">${[6, 12, 24].map(v => `<button data-v="${v}" class="${n === v ? 'on' : ''}">${v} mnd</button>`).join('')}</div>
      <button class="btn" id="all">Alle transacties</button></div></div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card kpi"><h2>${label} (${n} mnd)</h2><div class="v">${eur(r.total)}</div><div class="sub">${r.count} transacties</div></div>
      <div class="card kpi"><h2>Gemiddeld per maand</h2><div class="v">${eur(r.avg)}</div><div class="sub">${r.active} van ${n} maanden actief</div></div>
      <div class="card kpi"><h2>Per actieve maand</h2><div class="v">${eur(r.avgActive)}</div><div class="sub">gemiddelde als het voorkomt</div></div>
      <div class="card kpi"><h2>Grootste</h2><div class="v">${r.biggest ? eur(Math.abs(r.biggest.amount)) : '–'}</div><div class="sub">${r.biggest ? esc(r.biggest.payee) + ' · ' + fmtDay(r.biggest.date) : ''}</div></div></div>
    <div class="card" style="margin-bottom:16px"><h2>Per maand <span class="right muted">klik op een staaf voor de transacties</span></h2>${monthBars(r.monthly, r.color)}</div>
    <div class="grid g2">
      <div class="card"><h2>${r.type === 'category' ? 'Top tegenpartijen' : 'Verdeling over categorieën'}</h2>
        ${(r.merchants.length ? r.merchants : r.categories).map(x => `<div style="margin-bottom:10px" ${x.merchant ? `data-merchant="${esc(x.merchant)}"` : x.id ? `data-cat="${x.id}"` : ''}><div class="row between small"><span>${x.icon ? x.icon + ' ' : ''}${esc(x.name)} <span class="faint">${x.n}×</span></span><b>${eur(x.v)}</b></div>
          <div class="bar"><i style="width:${Math.max(2, Math.min(100, x.v / sharetotal * 100))}%;background:${x.color || r.color}"></i></div></div>`).join('') || '<div class="empty">Geen data in deze periode</div>'}</div>
      <div class="card" style="padding:0"><h2 style="padding:16px 18px 0">Recente transacties</h2><table>${r.recent.map(t => `<tr><td class="nowrap muted small">${fmtDay(t.date)}</td><td><div class="tx-name">${esc(t.payee)}</div><div class="small muted ellipsis">${esc(t.description.slice(0, 60))}</div></td><td class="num ${t.amount < 0 ? '' : 'pos'}"><b>${eur(t.amount)}</b></td></tr>`).join('')}</table></div></div>`);
  $('#back').onclick = () => go(S.backTab && S.backTab !== 'detail' ? S.backTab : 'dashboard');
  $('#all').onclick = () => { S.txFilter = d.category ? { category: d.category, all: true } : { merchant: d.merchant, all: true }; go('transactions'); };
  $('#dm').onclick = e => { if (e.target.dataset.v) { S.detailMonths = +e.target.dataset.v; V.detail(); } };
  m.querySelectorAll('[data-month]').forEach(g => g.addEventListener('click', () => { S.txFilter = d.category ? { category: d.category, month: g.dataset.month } : { merchant: d.merchant, month: g.dataset.month, all: false }; S.month = g.dataset.month; if (!d.category) S.txFilter.all = true; go('transactions'); }));
  m.querySelectorAll('[data-merchant]').forEach(el => el.addEventListener('click', () => openMerchant(el.dataset.merchant)));
  m.querySelectorAll('[data-cat]').forEach(el => el.addEventListener('click', () => openCategory(+el.dataset.cat)));
};

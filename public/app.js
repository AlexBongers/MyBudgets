// Frontend zonder framework. Bedragen komen binnen als centen.
const $ = (s, el = document) => el.querySelector(s);
const state = { tab: 'dashboard', month: null, cats: [], months: [] };
const eur = c => (c / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
const eur0 = c => (c / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const monthName = m => new Date(m + '-01T12:00').toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' });
const shortMonth = m => new Date(m + '-01T12:00').toLocaleDateString('nl-NL', { month: 'short' });
const catById = id => state.cats.find(c => c.id === id);

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, opts.body ? { method: opts.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : { method: opts.method || 'GET' });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Fout');
  return j;
}
let tt;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 3000); }
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast('⚠ ' + e.message); } };

function shiftMonth(m, n) { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); }

// ---------- Grafieken (SVG) ----------
function barChart(trend) {
  const W = 640, H = 220, pad = { l: 58, r: 8, t: 10, b: 24 };
  const max = Math.max(1, ...trend.flatMap(t => [t.income, t.expenses]));
  const bw = (W - pad.l - pad.r) / trend.length;
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Inkomsten en uitgaven per maand">`;
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4;
    s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${eur0(v)}</text>`;
  }
  trend.forEach((t, i) => {
    const x = pad.l + i * bw, w = bw * 0.36;
    s += `<rect x="${x + bw * 0.1}" y="${y(t.income)}" width="${w}" height="${y(0) - y(t.income)}" fill="var(--good)" rx="2"><title>${monthName(t.month)} inkomsten ${eur(t.income)}</title></rect>`;
    s += `<rect x="${x + bw * 0.1 + w + 2}" y="${y(t.expenses)}" width="${w}" height="${y(0) - y(t.expenses)}" fill="var(--bad)" rx="2"><title>${monthName(t.month)} uitgaven ${eur(t.expenses)}</title></rect>`;
    s += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${shortMonth(t.month)}</text>`;
  });
  return s + '</svg>';
}

function donut(items) {
  const total = items.reduce((a, b) => a + b.value, 0);
  if (!total) return '<div class="empty">Geen uitgaven</div>';
  const R = 70, r = 44, cx = 80, cy = 80; let a0 = -Math.PI / 2, paths = '';
  items.forEach(it => {
    const a1 = a0 + Math.min((it.value / total) * Math.PI * 2 - (items.length > 1 ? 0.01 : 0), Math.PI * 2 - 0.001), large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
    const [x0, y0] = p(R, a0), [x1, y1] = p(R, a1), [x2, y2] = p(r, a1), [x3, y3] = p(r, a0);
    paths += `<path d="M${x0} ${y0}A${R} ${R} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r} ${r} 0 ${large} 0 ${x3} ${y3}Z" fill="${it.color}"><title>${esc(it.name)}: ${eur(it.value)}</title></path>`;
    a0 += (it.value / total) * Math.PI * 2;
  });
  return `<svg viewBox="0 0 160 160" width="160" height="160">${paths}<text x="80" y="78" text-anchor="middle" style="font-size:10px">Totaal</text><text x="80" y="94" text-anchor="middle" style="font-size:13px;font-weight:700;fill:var(--text)">${eur0(total)}</text></svg>`;
}

// ---------- Tabs ----------
const tabs = {
  async dashboard() {
    const d = await api('/dashboard' + (state.month ? '?month=' + state.month : ''));
    setMonth(d.month, d.months);
    const net = d.totals.income - d.totals.expenses;
    const rate = d.totals.income > 0 ? Math.round((net / d.totals.income) * 100) : null;
    const totBudget = d.budget.reduce((a, b) => a + b.budget, 0), totSpent = d.budget.reduce((a, b) => a + b.spent, 0);
    $('#main').innerHTML = `
      ${d.uncategorized ? `<div class="banner">${d.uncategorized} transactie(s) zonder categorie. <a data-go="uncat">Nu categoriseren →</a></div>` : ''}
      <div class="grid cols-3" style="margin-bottom:16px">
        <div class="card kpi"><h2>Inkomsten</h2><div class="v pos">${eur(d.totals.income)}</div></div>
        <div class="card kpi"><h2>Uitgaven</h2><div class="v neg">${eur(d.totals.expenses)}</div></div>
        <div class="card kpi"><h2>Over / tekort</h2><div class="v ${net >= 0 ? 'pos' : 'neg'}">${eur(net)}</div><div class="muted">${rate !== null ? `Spaarquote ${rate}%` : ''}</div></div>
        <div class="card kpi"><h2>Budget</h2><div class="v">${totBudget ? eur0(totSpent) + ' / ' + eur0(totBudget) : '–'}</div><div class="muted">${totBudget ? Math.round(totSpent / totBudget * 100) + '% besteed' : 'Nog geen budget ingesteld'}</div></div>
      </div>
      <div class="grid cols-2">
        <div class="card"><h2>Laatste 12 maanden</h2>${barChart(d.trend)}<div class="row muted"><span><i class="dot" style="background:var(--good)"></i>Inkomsten</span><span><i class="dot" style="background:var(--bad)"></i>Uitgaven</span></div></div>
        <div class="card"><h2>Uitgaven per categorie</h2><div class="row" style="gap:20px;align-items:flex-start">${donut(d.byCategory)}
          <div class="legend" style="flex:1">${d.byCategory.slice(0, 8).map(c => `<div><span><i class="dot" style="background:${c.color}"></i>${esc(c.name)}</span><b>${eur(c.value)}</b></div>`).join('')}</div></div></div>
        <div class="card"><h2>Budget voortgang</h2>${budgetBars(d.budget)}</div>
        <div class="card"><h2>Top tegenpartijen</h2>${d.topPayees.length ? `<table>${d.topPayees.map(p => `<tr><td>${esc(p.payee)}</td><td class="muted">${p.n}×</td><td class="num">${eur(p.value)}</td></tr>`).join('')}</table>` : '<div class="empty">Geen data</div>'}</div>
      </div>`;
    $('[data-go=uncat]')?.addEventListener('click', () => { state.filter = { uncategorized: 1 }; switchTab('transactions'); });
  },

  async transactions() {
    const f = state.filter || {};
    const qs = new URLSearchParams();
    if (f.uncategorized) qs.set('uncategorized', 1); else if (state.month && !f.all) qs.set('month', state.month);
    if (f.category) qs.set('category', f.category);
    if (f.q) qs.set('q', f.q);
    const txs = await api('/transactions?' + qs);
    const opts = sel => `<option value="">— geen —</option>` + ['income', 'expense', 'transfer'].map(k => `<optgroup label="${{ income: 'Inkomen', expense: 'Uitgaven', transfer: 'Overboeking' }[k]}">${state.cats.filter(c => c.kind === k).map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
    $('#main').innerHTML = `
      <div class="toolbar">
        <input id="q" placeholder="Zoek op naam of omschrijving…" value="${esc(f.q || '')}" style="min-width:240px">
        <select id="fc"><option value="">Alle categorieën</option>${state.cats.map(c => `<option value="${c.id}" ${String(f.category) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <label class="row"><input type="checkbox" id="fu" ${f.uncategorized ? 'checked' : ''}> Alleen ongecategoriseerd (alle maanden)</label>
        <label class="row"><input type="checkbox" id="fa" ${f.all ? 'checked' : ''}> Alle maanden</label>
      </div>
      <div class="card">${txs.length ? `<table><thead><tr><th>Datum</th><th>Tegenpartij</th><th>Omschrijving</th><th>Categorie</th><th class="num">Bedrag</th></tr></thead><tbody>
        ${txs.map(t => `<tr><td>${t.date}</td><td>${esc(t.payee)}</td><td class="desc" title="${esc(t.description)}">${esc(t.description)}</td>
        <td><select data-id="${t.id}">${opts(t.category_id)}</select></td><td class="num ${t.amount < 0 ? 'neg' : 'pos'}">${eur(t.amount)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">Geen transacties. Importeer een Rabobank-CSV via “Importeren”.</div>'}</div>`;
    const reload = () => tabs.transactions();
    $('#q').addEventListener('change', e => { state.filter = { ...f, q: e.target.value }; reload(); });
    $('#fc').addEventListener('change', e => { state.filter = { ...f, category: e.target.value }; reload(); });
    $('#fu').addEventListener('change', e => { state.filter = { ...f, uncategorized: e.target.checked }; reload(); });
    $('#fa').addEventListener('change', e => { state.filter = { ...f, all: e.target.checked }; reload(); });
    document.querySelectorAll('select[data-id]').forEach(sel => sel.addEventListener('change', guard(async () => {
      const id = Number(sel.dataset.id), cat = sel.value ? Number(sel.value) : null, tx = txs.find(t => t.id === id);
      let createRule = false;
      if (cat && confirm(`Altijd “${tx.payee}” indelen onder “${catById(cat).name}”?\n\nOK = maak regel en pas toe op andere ongecategoriseerde transacties van deze tegenpartij.\nAnnuleren = alleen deze transactie.`)) createRule = true;
      const r = await api('/transactions/' + id, { method: 'PATCH', body: { category_id: cat, createRule } });
      toast(r.similar ? `Opgeslagen (+${r.similar} vergelijkbare)` : 'Opgeslagen');
      if (createRule) reload();
    })));
  },

  async budget() {
    const rows = await api('/budget?month=' + state.month);
    const tb = rows.reduce((a, b) => a + b.budget, 0), ts = rows.reduce((a, b) => a + b.spent, 0);
    $('#main').innerHTML = `<div class="card"><p class="muted" style="margin-top:0">Stel per categorie een maandbudget in. Een budget geldt vanaf de gekozen maand en blijft gelden tot je het opnieuw wijzigt.</p>
      <table><thead><tr><th>Categorie</th><th style="width:30%">Voortgang</th><th class="num">Budget (€)</th><th class="num">Besteed</th><th class="num">Resterend</th></tr></thead><tbody>
      ${rows.map(r => { const left = r.budget - r.spent; return `<tr><td><i class="dot" style="background:${r.color}"></i>${esc(r.name)}</td>
        <td>${bar(r)}</td><td class="num"><input type="number" min="0" step="1" value="${r.budget / 100}" data-cat="${r.id}" style="width:90px;text-align:right"></td>
        <td class="num">${eur(r.spent)}</td><td class="num ${left < 0 ? 'neg' : 'pos'}">${eur(left)}</td></tr>`; }).join('')}
      <tr><th>Totaal</th><td></td><th class="num">${eur(tb)}</th><th class="num">${eur(ts)}</th><th class="num">${eur(tb - ts)}</th></tr></tbody></table></div>`;
    document.querySelectorAll('input[data-cat]').forEach(i => i.addEventListener('change', guard(async () => {
      await api('/budget', { method: 'PUT', body: { category_id: Number(i.dataset.cat), month: state.month, amount: Math.round(Number(i.value) * 100) } });
      toast('Budget opgeslagen'); tabs.budget();
    })));
  },

  async categories() {
    const rules = await api('/rules');
    const kindNl = { income: 'Inkomen', expense: 'Uitgave', transfer: 'Overboeking' };
    $('#main').innerHTML = `<div class="grid cols-2">
      <div class="card"><h2>Categorieën</h2>
        <table>${state.cats.map(c => `<tr><td><input type="color" value="${c.color}" data-color="${c.id}" style="padding:0;width:32px;height:26px"></td>
          <td><input value="${esc(c.name)}" data-name="${c.id}"></td><td class="muted">${kindNl[c.kind]}</td>
          <td><button class="btn danger" data-del="${c.id}" title="Verwijderen">✕</button></td></tr>`).join('')}</table>
        <form id="nc" class="row" style="margin-top:12px"><input name="name" placeholder="Nieuwe categorie" required>
          <select name="kind"><option value="expense">Uitgave</option><option value="income">Inkomen</option><option value="transfer">Overboeking (telt niet mee)</option></select>
          <button class="btn primary">Toevoegen</button></form></div>
      <div class="card"><h2>Regels (automatisch categoriseren)</h2>
        <p class="muted" style="margin-top:0">Als tegenpartij of omschrijving de tekst bevat, krijgt de transactie die categorie.</p>
        <form id="nr" class="row" style="margin-bottom:12px"><input name="pattern" placeholder="bv. albert heijn" required>
          <select name="category_id">${state.cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
          <button class="btn primary">Toevoegen</button></form>
        <div style="max-height:480px;overflow:auto"><table>${rules.map(r => `<tr><td>${esc(r.pattern)}</td><td class="muted">→ ${esc(r.category)}</td><td><button class="btn danger" data-rdel="${r.id}">✕</button></td></tr>`).join('')}</table></div>
        <button class="btn" id="apply" style="margin-top:12px">Regels toepassen op ongecategoriseerde transacties</button></div></div>`;
    const refresh = async () => { state.cats = await api('/categories'); tabs.categories(); };
    document.querySelectorAll('[data-color]').forEach(i => i.addEventListener('change', guard(async () => { await api('/categories/' + i.dataset.color, { method: 'PUT', body: { color: i.value } }); toast('Opgeslagen'); })));
    document.querySelectorAll('[data-name]').forEach(i => i.addEventListener('change', guard(async () => { await api('/categories/' + i.dataset.name, { method: 'PUT', body: { name: i.value } }); toast('Opgeslagen'); state.cats = await api('/categories'); })));
    document.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', guard(async () => { if (confirm('Categorie verwijderen? Transacties worden ongecategoriseerd, budgetten en regels verdwijnen.')) { await api('/categories/' + b.dataset.del, { method: 'DELETE' }); refresh(); } })));
    document.querySelectorAll('[data-rdel]').forEach(b => b.addEventListener('click', guard(async () => { await api('/rules/' + b.dataset.rdel, { method: 'DELETE' }); tabs.categories(); })));
    $('#nc').addEventListener('submit', guard(async e => { e.preventDefault(); const f = new FormData(e.target); await api('/categories', { body: { name: f.get('name'), kind: f.get('kind') } }); refresh(); }));
    $('#nr').addEventListener('submit', guard(async e => { e.preventDefault(); const f = new FormData(e.target); const r = await api('/rules', { body: { pattern: f.get('pattern'), category_id: Number(f.get('category_id')) } }); toast(`Regel toegevoegd, ${r.applied} transactie(s) ingedeeld`); tabs.categories(); }));
    $('#apply').addEventListener('click', guard(async () => { const r = await api('/rules/apply', { body: {} }); toast(`${r.applied} transactie(s) ingedeeld`); }));
  },

  async import() {
    $('#main').innerHTML = `<div class="card"><h2>Rabobank CSV importeren</h2>
      <p class="muted" style="margin-top:0">Download in Rabo Internetbankieren je transacties als <b>CSV</b> (kommagescheiden) en sleep het bestand hierheen. Dubbele transacties worden automatisch overgeslagen, dus je kunt gerust overlappende periodes importeren.</p>
      <label class="dz" id="dz">Sleep CSV hierheen of klik om te kiezen<input type="file" id="file" accept=".csv,text/csv" multiple hidden></label>
      <div id="res" style="margin-top:12px"></div></div>`;
    const dz = $('#dz');
    const handle = guard(async files => {
      for (const f of files) {
        const r = await api('/import', { body: { csv: await f.text() } });
        $('#res').insertAdjacentHTML('beforeend', `<p><b>${esc(f.name)}</b>: ${r.added} nieuw, ${r.skipped} dubbel overgeslagen, ${r.categorized} automatisch gecategoriseerd.</p>`);
      }
      const d = await api('/dashboard'); setMonth(d.month, d.months);
      $('#res').insertAdjacentHTML('beforeend', `<button class="btn primary" id="go">Naar dashboard</button>`);
      $('#go').onclick = () => switchTab('dashboard');
    });
    $('#file').addEventListener('change', e => handle([...e.target.files]));
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); handle([...e.dataTransfer.files]); });
  },
};

function bar(r) {
  const pct = r.budget ? Math.min(100, r.spent / r.budget * 100) : (r.spent ? 100 : 0);
  const col = !r.budget ? 'var(--muted)' : r.spent > r.budget ? 'var(--bad)' : r.spent > r.budget * .85 ? 'var(--warn)' : 'var(--good)';
  return `<div class="bar"><i style="width:${pct}%;background:${col}"></i></div>`;
}
function budgetBars(rows) {
  if (!rows.length) return '<div class="empty">Stel een budget in via het tabblad Budget</div>';
  return rows.map(r => `<div style="margin-bottom:10px"><div class="row" style="justify-content:space-between"><span><i class="dot" style="background:${r.color}"></i>${esc(r.name)}</span><span class="muted">${eur0(r.spent)} / ${eur0(r.budget)}</span></div>${bar(r)}</div>`).join('');
}

function setMonth(m, months) {
  state.month = m; if (months) state.months = months;
  $('#monthlabel').textContent = monthName(m);
  $('#monthpick').style.visibility = ['categories', 'import'].includes(state.tab) ? 'hidden' : 'visible';
}
async function switchTab(t) {
  state.tab = t;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  $('#monthpick').style.visibility = ['categories', 'import'].includes(t) ? 'hidden' : 'visible';
  await guard(() => tabs[t]())();
}
$('#nav').addEventListener('click', e => { if (e.target.dataset.tab) { if (e.target.dataset.tab !== 'transactions') state.filter = null; switchTab(e.target.dataset.tab); } });
$('#prev').onclick = () => { state.month = shiftMonth(state.month, -1); switchTab(state.tab); };
$('#next').onclick = () => { state.month = shiftMonth(state.month, 1); switchTab(state.tab); };

guard(async () => {
  state.cats = await api('/categories');
  const d = await api('/dashboard'); state.month = d.month; state.months = d.months;
  await switchTab('dashboard');
})();

'use strict';
const V = {};
const SRC = { pair: 'overboeking', rule: 'regel', own: 'eigen rekening', memory: 'geleerd', builtin: 'bekend', heur: 'afgeleid', ml: 'suggestie', manual: 'handmatig' };

function emptyHero() {
  return `<div class="hero"><div class="big">🌷</div><h2>Welkom bij MyBudgets</h2>
    <p>Importeer je Rabobank-transacties en krijg direct inzicht. Alles blijft lokaal op je Mac.</p>
    <div class="row" style="justify-content:center;margin-bottom:26px"><button class="btn primary" data-act="import">Rabobank CSV kiezen…</button><button class="btn" data-act="demo">Probeer met voorbeelddata</button></div>
    <div class="card" style="text-align:left"><h2>Zo exporteer je uit Rabo Internetbankieren</h2>
      <ol class="steps"><li>Log in en open je <b>betaalrekening</b> → <b>Transacties</b>.</li><li>Kies <b>Downloaden</b> en selecteer de periode (bijv. het hele laatste jaar).</li>
      <li>Kies formaat <b>CSV</b> (kommagescheiden) en download het bestand.</li><li>Sleep het bestand in dit venster of kies <kbd>⌘O</kbd>.</li></ol></div></div>`;
}

V.dashboard = async () => {
  const d = await GET('/dashboard' + (S.month ? '?month=' + S.month : ''));
  setMonth(d.month, d.months); S.accounts = d.accounts; S.review = d.review; S.hasData = d.txCount > 0; updateNav();
  if (!d.txCount) { const m = render(emptyHero()); bindHero(m); return; }
  const t = d.totals, p = d.prevTotals, net = t.income - t.expenses, rate = t.income > 0 ? Math.round(net / t.income * 100) : null;
  const bal = d.accounts.filter(a => a.balance != null).reduce((a, b) => a + b.balance, 0), hasBal = d.accounts.some(a => a.balance != null);
  const totBudget = d.budget.reduce((a, b) => a + b.budget, 0);
  const rec = d.recurringMonthly;
  const m = render(`
    ${d.review ? `<div class="banner"><span>📥</span><span><b>${d.review}</b> transactie${d.review === 1 ? '' : 's'} wacht${d.review === 1 ? '' : 'en'} op je beoordeling.</span><span class="spacer"></span><button class="btn primary sm" data-go="review">Beoordelen</button></div>` : ''}
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card kpi"><h2>Inkomsten</h2><div class="v pos">${eur(t.income)}</div><div class="sub">${deltaChip(t.income, p.income, false)}</div></div>
      <div class="card kpi"><h2>Uitgaven</h2><div class="v">${eur(t.expenses)}</div><div class="sub">${deltaChip(t.expenses, p.expenses, true)}${totBudget ? `<span>van ${eur0(totBudget)} budget</span>` : ''}</div></div>
      <div class="card kpi"><h2>Over / tekort</h2><div class="v ${net >= 0 ? 'pos' : 'neg'}">${eurSigned(net)}</div><div class="sub">${rate !== null ? `Spaarquote ${rate}%` : 'Nog geen inkomen deze maand'}</div></div>
      <div class="card kpi"><h2>Saldo</h2><div class="v">${hasBal ? eur(bal) : '–'}</div><div class="sub">${d.accounts.length} rekening${d.accounts.length === 1 ? '' : 'en'}${rec ? ` · vaste lasten ${eur0(rec)}/mnd` : ''}</div></div>
    </div>
    <div class="grid g21" style="margin-bottom:16px">
      <div class="card"><h2>Uitgaven deze maand <span class="right"><span class="dot" style="background:var(--accent)"></span> ${monthName(d.month)} &nbsp;<span class="dot" style="background:var(--faint)"></span> vorige maand</span></h2>${lineChart(d.cumul, totBudget, d.projection?.expenses)}</div>
      <div class="card"><h2>Inzichten</h2>${d.insights.length ? d.insights.map(i => `<div class="insight"><span class="ic ${i.type}"></span><span>${esc(i.text)}</span></div>`).join('') : '<div class="empty">Nog geen inzichten</div>'}</div>
    </div>
    <div class="grid g2" style="margin-bottom:16px">
      <div class="card"><h2>Laatste 12 maanden <span class="right"><span class="dot" style="background:var(--good)"></span> inkomsten &nbsp;<span class="dot" style="background:var(--bad)"></span> uitgaven</span></h2>${barChart(d.trend, d.month)}</div>
      <div class="card"><h2>Uitgaven per categorie</h2><div class="row" style="gap:16px;align-items:flex-start;flex-wrap:nowrap" id="catdonut">${donut(d.byCategory)}
        <div class="legend">${d.byCategory.slice(0, 9).map(c => `<div class="li" data-cat="${c.id ?? ''}"><span><i class="dot" style="background:${c.color}"></i> ${c.icon} ${esc(c.name)}</span><span class="nowrap"><b>${eur0(c.value)}</b> ${c.prev && Math.abs(c.value - c.prev) > c.prev * 0.05 ? deltaChip(c.value, c.prev, true) : ''}</span></div>`).join('')}</div></div></div>
    </div>
    <div class="grid g2">
      <div class="card"><h2>Budget <span class="right"><a href="#" data-go="budget">Aanpassen</a></span></h2>${d.budget.some(b => b.budget > 0) ? d.budget.filter(b => b.budget > 0).sort((a, b) => (b.spent / (b.limit || 1)) - (a.spent / (a.limit || 1))).slice(0, 8).map(b => `<div style="margin-bottom:11px"><div class="row between small"><span>${b.icon} ${esc(b.name)}</span><span class="muted">${eur0(b.spent)} / ${eur0(b.limit)}</span></div>${progressBar(b.spent, b.limit)}</div>`).join('') : '<div class="empty">Nog geen budget ingesteld.<br><button class="btn sm" data-go="budget" style="margin-top:8px">Budget instellen</button></div>'}</div>
      <div class="card"><h2>Top tegenpartijen</h2>${d.topPayees.length ? `<table>${d.topPayees.slice(0, 6).map(x => `<tr data-payee="${esc(x.merchant)}" style="cursor:default"><td>${x.icon} ${esc(x.payee)}</td><td class="muted small">${x.n}×</td><td class="num"><b>${eur(x.value)}</b></td></tr>`).join('')}</table>` : '<div class="empty">Geen data</div>'}</div>
    </div>
    <div class="grid g21" style="margin-top:16px">
      <div class="card"><h2>Saldo-verloop <span class="right muted">alle rekeningen</span></h2>${d.balanceHistory.length > 1 ? areaChart(d.balanceHistory) : '<div class="empty">Het saldo-verloop verschijnt zodra je CSV de kolom “Saldo na trn” bevat.</div>'}</div>
      <div class="card"><h2>Binnenkort verwacht <span class="right muted">30 dagen</span></h2>${d.upcoming.length ? `<table>${d.upcoming.slice(0, 7).map(u => `<tr data-payee="${esc(u.merchant)}"><td class="nowrap muted small">${fmtDay(u.next)}</td><td>${esc(u.name)}</td><td class="num">${u.variable ? '~' : ''}${eur0(u.amount)}</td></tr>`).join('')}${d.upcoming.length > 7 ? `<tr><td></td><td class="muted small">+ ${d.upcoming.length - 7} meer</td><td></td></tr>` : ''}<tr><td></td><td><b>Totaal</b></td><td class="num"><b>${eur0(d.upcoming.reduce((a, u) => a + u.amount, 0))}</b></td></tr></table>` : '<div class="empty">Geen vaste lasten verwacht</div>'}</div>
    </div>
    <div id="goalsbox" style="margin-top:16px"></div>`);
  renderGoals();
  m.querySelectorAll('[data-go]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); go(a.dataset.go); }));
  m.querySelectorAll('[data-month]').forEach(g => g.addEventListener('click', () => { S.month = g.dataset.month; go('dashboard'); }));
  m.querySelectorAll('[data-cat]').forEach(el => el.addEventListener('click', () => openCategory(el.dataset.cat ? +el.dataset.cat : null)));
  m.querySelectorAll('[data-payee]').forEach(el => el.addEventListener('click', () => openMerchant(el.dataset.payee)));
};

function bindHero(m) {
  m.querySelector('[data-act=import]')?.addEventListener('click', () => go('import'));
  m.querySelector('[data-act=demo]')?.addEventListener('click', guard(async () => { const r = await POST('/demo'); toast(`${r.added} voorbeeldtransacties geladen`); S.month = null; await refreshMeta(); go('dashboard'); }));
}

// ---------- Te beoordelen ----------
V.review = async () => {
  const groups = await GET('/review');
  S.review = groups.reduce((a, g) => a + g.count, 0); updateNav();
  if (!groups.length) { render(`<div class="hero"><div class="big">✅</div><h2>Alles is ingedeeld</h2><p>Geen transacties die je aandacht nodig hebben. Nieuwe imports worden automatisch gecategoriseerd; wat de module niet zeker weet, verschijnt hier.</p><button class="btn primary" data-go="dashboard">Naar dashboard</button></div>`).querySelector('[data-go]').onclick = () => go('dashboard'); return; }
  const withSug = groups.filter(g => g.suggestions.length);
  const m = render(`
    <div class="row between" style="margin-bottom:14px"><div><b>${groups.length}</b> tegenpartijen · <b>${S.review}</b> transacties <span class="muted">— deel in per tegenpartij; MyBudgets leert van je keuzes.</span></div>
      ${withSug.length ? `<button class="btn" id="acceptall">✓ Bevestig alle suggesties (${withSug.reduce((a, g) => a + g.count, 0)})</button>` : ''}</div>
    <div class="muted small" style="margin:-4px 0 12px">⌨️ <kbd>j</kbd>/<kbd>k</kbd> bladeren · <kbd>Enter</kbd> suggestie bevestigen · <kbd>c</kbd> andere categorie · <kbd>r</kbd> regel maken · <kbd>v</kbd> transacties tonen</div>
    <div class="stack" id="rvlist">${groups.map(g => {
      const sug = g.suggestions.slice(0, 2);
      return `<div class="card rv" data-merchant="${esc(g.merchant)}" data-ids="${g.ids.join(',')}">
        <div style="min-width:0"><div class="row"><b>${esc(g.name)}</b><span class="tag">${g.count} transactie${g.count === 1 ? '' : 's'}</span><span class="${g.total < 0 ? '' : 'pos'}"><b>${eur(g.total)}</b></span></div>
          <div class="sample">${g.samples.map(s => `${fmtDay(s.date)} ${eur(s.amount)} ${esc(s.description.slice(0, 50))}`).join(' · ')}</div>
          ${sug.length ? `<div class="small faint">${esc(sug[0].reason || '')}</div>` : '<div class="small faint">Geen suggestie — kies een categorie</div>'}</div>
        <div class="rv-actions">${sug.map((s, i) => { const c = catById(s.category_id); return c ? `<button class="btn sm ${i ? '' : 'primary'}" data-accept="${c.id}" title="${esc(s.reason || '')}">${c.icon} ${esc(c.name)}${i ? '' : ' ✓'}</button>` : ''; }).join('')}
          ${catSelect(null, { none: 'Andere categorie…', attrs: 'data-pick' })}
          <button class="btn sm ghost" data-rule title="Regel maken (r)">⚙︎</button><button class="btn sm ghost" data-view title="Transacties tonen (v)">↗</button></div></div>`;
    }).join('')}</div>`);
  const assign = guard(async (card, catId) => {
    const ids = card.dataset.ids.split(',').map(Number);
    const r = await POST('/transactions/bulk', { ids, category_id: Number(catId) });
    card.classList.add('done'); toast(`${r.updated} ingedeeld${r.similar ? ` · +${r.similar} vergelijkbare automatisch` : ''}`, r.undo);
    setTimeout(() => V.review(), 280);
  });
  m.querySelectorAll('.rv').forEach(card => {
    card.querySelectorAll('[data-accept]').forEach(b => b.addEventListener('click', () => assign(card, b.dataset.accept)));
    card.querySelector('[data-pick]').addEventListener('change', e => e.target.value && assign(card, e.target.value));
    card.querySelector('[data-view]').addEventListener('click', () => { S.txFilter = { merchant: card.dataset.merchant, all: true }; go('transactions'); });
    card.querySelector('[data-rule]').addEventListener('click', () => { const g = groups.find(x => x.merchant === card.dataset.merchant); ruleModal(null, { field: 'payee', op: 'contains', pattern: g.name, category_id: g.suggestions[0]?.category_id || null }); });
  });
  // Toetsenbord: j/k bladeren, Enter bevestigt de suggestie, c kiest zelf, r maakt een regel
  const cards = $$('.rv'); let cur = 0;
  const focusCard = i => { cur = Math.max(0, Math.min(cards.length - 1, i)); cards.forEach((c, n) => { c.style.outline = n === cur ? '2px solid var(--accent)' : ''; }); cards[cur]?.scrollIntoView({ block: 'nearest' }); };
  setKeyHandler(e => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches('input,textarea') || document.querySelector('.overlay')) return;
    const card = cards[cur]; if (!card) return;
    if (e.target.matches('select')) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); focusCard(cur + 1); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); focusCard(cur - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); card.querySelector('[data-accept]')?.click(); }
    else if (e.key === 'c') { e.preventDefault(); card.querySelector('[data-pick]').focus(); }
    else if (e.key === 'r') { e.preventDefault(); card.querySelector('[data-rule]').click(); }
    else if (e.key === 'v') { e.preventDefault(); card.querySelector('[data-view]').click(); }
  });
  focusCard(0);
  $('#acceptall')?.addEventListener('click', guard(async () => {
    if (!(await ask('Alle suggesties bevestigen?', `Je bevestigt de voorgestelde categorie voor ${withSug.length} tegenpartijen. Je kunt dit later altijd nog aanpassen.`, 'Bevestigen'))) return;
    const r = await POST('/transactions/confirm', { ids: withSug.flatMap(g => g.ids) }); toast(`${r.confirmed} bevestigd`, r.undo); V.review();
  }));
};

// ---------- Transacties ----------
V.transactions = async () => {
  const f = S.txFilter = Object.assign({ sort: 'date', dir: 'desc' }, S.txFilter);
  const selected = new Set(); let loaded = 0, total = 0;
  const showAll = f.all || f.merchant || f.status || f.q;
  const m = render(`
    <div class="filters">
      <input type="search" id="q" placeholder="Zoek op naam, omschrijving, IBAN…" value="${esc(f.q || '')}">
      ${catSelect(f.category === 'none' ? '' : Number(f.category) || null, { none: 'Alle categorieën', attrs: 'id="fcat"' }).replace('</optgroup></select>', '</optgroup><option value="none" ' + (f.category === 'none' ? 'selected' : '') + '>❔ Zonder categorie</option></select>')}
      ${S.accounts.length > 1 ? `<select id="facc"><option value="">Alle rekeningen</option>${S.accounts.map(a => `<option value="${a.id}" ${String(f.account) === String(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}
      <div class="seg" id="ftype">${[['', 'Alles'], ['out', 'Uit'], ['in', 'In']].map(([v, l]) => `<button data-v="${v}" class="${(f.type || '') === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="seg" id="fscope"><button data-v="month" class="${!showAll ? 'on' : ''}">${esc(monthName(S.month || ''))}</button><button data-v="all" class="${showAll ? 'on' : ''}">Alle maanden</button></div>
      <label class="row small"><input type="checkbox" id="frev" ${f.status === 'review' ? 'checked' : ''}> Alleen te beoordelen</label>
      ${f.merchant ? `<span class="chip" style="--c:#0a84ff">Tegenpartij: ${esc(f.merchant)} <a href="#" id="clrm">✕</a></span>` : ''}
    </div>
    <div class="card" style="padding:0"><div class="tablewrap"><table><thead><tr>
      <th style="width:30px"><input type="checkbox" id="selall"></th>
      <th class="sortable" data-sort="date">Datum</th><th class="sortable" data-sort="payee">Tegenpartij</th><th>Categorie</th><th class="sortable num" data-sort="amount">Bedrag</th></tr></thead>
      <tbody id="rows"></tbody></table></div><div class="row between" style="padding:10px 16px;border-top:1px solid var(--line)"><span class="muted small" id="summary"></span><button class="btn sm" id="more" hidden>Meer laden</button></div></div>
    <div id="bulk"></div>`);
  const query = off => {
    const p = new URLSearchParams({ sort: f.sort, dir: f.dir, offset: off, limit: 300 });
    if (!showAll) p.set('month', S.month); if (f.month && !f.all) p.set('month', f.month);
    for (const k of ['q', 'category', 'account', 'type', 'status', 'merchant']) if (f[k]) p.set(k, f[k]);
    return p.toString();
  };
  const rowHtml = t => {
    const c = catById(t.category_id), weak = !t.confirmed && (!t.category_id || t.cat_conf < 0.8);
    const tag = t.confirmed || t.cat_source === 'manual' ? '' : weak ? `<span class="tag warn" title="${esc(t.cat_reason)}">controleer</span>` : t.cat_source ? `<span class="tag" title="${esc(t.cat_reason)}">${SRC[t.cat_source] || 'auto'}</span>` : '';
    return `<tr data-id="${t.id}"><td><input type="checkbox" class="sel" ${selected.has(t.id) ? 'checked' : ''}></td><td class="nowrap">${fmtDay(t.date)}</td>
      <td><div class="tx-name"><a href="#" class="open" style="color:inherit;text-decoration:none">${esc(t.payee)}</a>${t.notes ? ' 📝' : ''}</div><div class="small muted" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.description)}</div></td>
      <td>${t.split_count ? `<button class="btn sm open-split" title="Splitsing bekijken of wijzigen">✂️ Gesplitst · ${t.split_count} delen</button>` : `<div class="row" style="flex-wrap:nowrap">${catSelect(t.category_id, { none: '❔ kies…', cls: 'cat-input rowcat' })}${tag}</div>`}</td>
      <td class="num ${t.amount < 0 ? '' : 'pos'}"><b>${eur(t.amount)}</b></td></tr>`;
  };
  const load = guard(async (append) => {
    const off = append ? loaded : 0, top = $('#main').scrollTop;
    const r = await GET('/transactions?' + query(off));
    total = r.total; loaded = off + r.rows.length;
    $('#rows').insertAdjacentHTML(append ? 'beforeend' : 'afterbegin', r.rows.map(rowHtml).join('')); if (!append) { /* gereset door aanroeper */ }
    $('#summary').textContent = `${total} transactie${total === 1 ? '' : 's'} · som ${eurSigned(r.sum)}${loaded < total ? ` · ${loaded} getoond` : ''}`;
    $('#more').hidden = loaded >= total;
    if (!r.rows.length && !append) $('#rows').innerHTML = `<tr><td colspan="5" class="empty">Geen transacties gevonden</td></tr>`;
    $('#main').scrollTop = top;
  });
  const reload = () => { $('#rows').innerHTML = ''; selected.clear(); bulk(); return load(false); };
  const bulk = () => {
    const el = $('#bulk');
    el.innerHTML = selected.size ? `<div class="bulkbar"><b>${selected.size} geselecteerd</b><span class="spacer"></span>${catSelect(null, { none: 'Categorie kiezen…', attrs: 'id="bulkcat"' })}<button class="btn sm" id="bulkgo">Toepassen</button><button class="btn sm ghost" id="bulkx" style="color:inherit">✕</button></div>` : '';
    $('#bulkgo')?.addEventListener('click', guard(async () => {
      const cat = $('#bulkcat').value; if (!cat) return toast('Kies eerst een categorie');
      const r = await POST('/transactions/bulk', { ids: [...selected], category_id: Number(cat) }); toast(`${r.updated} ingedeeld`, r.undo); await refreshMeta(); reload();
    }));
    $('#bulkx')?.addEventListener('click', () => { selected.clear(); $$('.sel').forEach(c => c.checked = false); $('#selall').checked = false; bulk(); });
  };
  const set = (k, v) => { f[k] = v || undefined; if (k !== 'all') delete f.offset; };
  $('#q').addEventListener('input', debounce(e => { set('q', e.target.value.trim()); V.transactions(); }, 350));
  $('#fcat').addEventListener('change', e => { set('category', e.target.value); V.transactions(); });
  $('#facc')?.addEventListener('change', e => { set('account', e.target.value); V.transactions(); });
  $('#ftype').addEventListener('click', e => { if (e.target.dataset.v !== undefined) { set('type', e.target.dataset.v); V.transactions(); } });
  $('#fscope').addEventListener('click', e => { if (e.target.dataset.v) { f.all = e.target.dataset.v === 'all'; if (!f.all) { delete f.merchant; delete f.month; } V.transactions(); } });
  $('#frev').addEventListener('change', e => { set('status', e.target.checked ? 'review' : ''); V.transactions(); });
  $('#clrm')?.addEventListener('click', e => { e.preventDefault(); delete f.merchant; V.transactions(); });
  $('#more').addEventListener('click', () => load(true));
  $$('th.sortable').forEach(th => th.addEventListener('click', () => { f.dir = f.sort === th.dataset.sort && f.dir === 'desc' ? 'asc' : 'desc'; f.sort = th.dataset.sort; V.transactions(); }));
  $('#selall').addEventListener('change', e => { $$('tr[data-id]').forEach(tr => { const id = +tr.dataset.id; tr.querySelector('.sel').checked = e.target.checked; e.target.checked ? selected.add(id) : selected.delete(id); }); bulk(); });
  $('#rows').addEventListener('change', guard(async e => {
    const tr = e.target.closest('tr'); if (!tr) return; const id = +tr.dataset.id;
    if (e.target.classList.contains('sel')) { e.target.checked ? selected.add(id) : selected.delete(id); return bulk(); }
    if (e.target.classList.contains('rowcat')) {
      const r = await PATCH('/transactions/' + id, { category_id: e.target.value ? Number(e.target.value) : null });
      toast(r.similar ? `Opgeslagen · ${r.similar} vergelijkbare automatisch ingedeeld` : 'Opgeslagen', r.undo); await refreshMeta(); reload();
    }
  }));
  $('#rows').addEventListener('click', e => { const a = e.target.closest('a.open'); if (a) { e.preventDefault(); txDetail(+a.closest('tr').dataset.id); } const b = e.target.closest('.open-split'); if (b) splitModal(+b.closest('tr').dataset.id); });
  await load(false);
  if (f.focusSearch) { $('#q').focus(); delete f.focusSearch; }
};

async function txDetail(id) {
  const row = await GET('/transactions/' + id); if (!row) return;
  const c = catById(row.category_id);
  const m = modal(`<h3>${esc(row.payee)}</h3>
    <div class="form">
      <label>Datum</label><div>${fmtDate(row.date)}</div><label>Bedrag</label><div class="${row.amount < 0 ? '' : 'pos'}"><b>${eur(row.amount)}</b></div>
      <label>Omschrijving</label><div style="white-space:pre-wrap;word-break:break-word">${esc(row.description) || '<span class="muted">–</span>'}</div>
      ${row.counter_iban ? `<label>Tegenrekening</label><div>${esc(row.counter_iban)}</div>` : ''}${row.code ? `<label>Rabo-code</label><div>${esc(row.code)}</div>` : ''}
      <label>Categorie</label><div>${catChip(c)}</div>
      <label>Waarom?</label><div class="muted">${esc(row.cat_reason || (row.category_id ? '' : 'Geen categorie gevonden'))} ${row.cat_source ? `<span class="tag">${SRC[row.cat_source]}</span>` : ''}</div>
      <label>Notitie</label><textarea id="note" rows="2" placeholder="Eigen notitie…">${esc(row.notes)}</textarea></div>
    <div class="foot"><button class="btn danger" id="del">Verwijderen</button><span class="spacer" style="flex:1"></span><button class="btn" id="split">✂️ Splitsen…</button><button class="btn" id="rule">Regel maken…</button><button class="btn" id="same">Overzicht partij</button><button class="btn primary" id="save">Opslaan</button></div>`);
  m.$('#save').onclick = guard(async () => { await PATCH('/transactions/' + id, { notes: m.$('#note').value }); m.close(); toast('Opgeslagen'); V.transactions(); });
  m.$('#same').onclick = () => { m.close(); openMerchant(row.merchant); };
  m.$('#split').onclick = () => { m.close(); splitModal(id); };
  m.$('#rule').onclick = () => { m.close(); ruleModal(null, { field: 'payee', op: 'contains', pattern: row.payee, category_id: row.category_id }); };
  m.$('#del').onclick = guard(async () => { if (await ask('Transactie verwijderen?', 'Dit kan niet ongedaan worden gemaakt. Bij een nieuwe import komt hij weer terug.', 'Verwijderen', true)) { await DEL('/transactions/' + id); m.close(); toast('Verwijderd'); await refreshMeta(); V.transactions(); } });
}

// ---------- splitsen ----------
async function splitModal(id) {
  const t = await GET('/transactions/' + id);
  const total = Math.abs(t.amount), sign = Math.sign(t.amount);
  let parts = t.splits.length ? t.splits.map(s => ({ ...s, amount: Math.abs(s.amount) }))
    : [{ category_id: t.category_id, amount: total, note: '' }, { category_id: null, amount: 0, note: '' }];
  const m = modal(`<h3>Splitsen: ${esc(t.payee)}</h3><p class="muted" style="margin-top:-6px">${fmtDate(t.date)} · totaal <b>${eur(total)}</b>. Verdeel het bedrag over meerdere categorieën, bijvoorbeeld boodschappen en huishouden bij één kassabon.</p>
    <div id="parts" class="stack"></div><div class="row between" style="margin-top:10px"><button class="btn sm" id="addp">+ Deel toevoegen</button><b id="rest"></b></div>
    <div class="foot">${t.splits.length ? '<button class="btn danger" id="unsplit">Splitsing opheffen</button><span style="flex:1"></span>' : ''}<button class="btn" data-close>Annuleren</button><button class="btn primary" id="save">Opslaan</button></div>`, { wide: true });
  const draw = () => {
    m.$('#parts').innerHTML = parts.map((p, i) => `<div class="row" style="flex-wrap:nowrap" data-i="${i}">${catSelect(p.category_id, { none: '— categorie —', attrs: 'data-f="cat"' })}
      <input type="number" step="0.01" min="0" data-f="amt" value="${p.amount ? (p.amount / 100).toFixed(2) : ''}" placeholder="0,00" style="width:110px;text-align:right"><input data-f="note" value="${esc(p.note || '')}" placeholder="Notitie (optioneel)" style="flex:1">
      ${parts.length > 2 ? '<button class="btn sm danger" data-f="del">✕</button>' : ''}</div>`).join('');
    const rest = total - parts.reduce((a, p) => a + p.amount, 0);
    m.$('#rest').innerHTML = rest === 0 ? '<span class="pos">✓ Volledig verdeeld</span>' : `<span class="${rest < 0 ? 'neg' : 'muted'}">Nog te verdelen: ${eur(rest)}</span>`;
    m.$('#save').disabled = rest !== 0 || parts.some(p => !p.category_id || !p.amount);
  };
  m.$('#parts').addEventListener('change', e => {
    const row = e.target.closest('[data-i]'); if (!row) return; const p = parts[+row.dataset.i], f = e.target.dataset.f;
    if (f === 'cat') p.category_id = Number(e.target.value) || null;
    else if (f === 'amt') p.amount = Math.max(0, Math.round(Number(e.target.value) * 100) || 0);
    else if (f === 'note') p.note = e.target.value;
    draw();
  });
  m.$('#parts').addEventListener('click', e => { const row = e.target.closest('[data-i]'); if (row && e.target.dataset.f === 'del') { parts.splice(+row.dataset.i, 1); draw(); } });
  m.$('#addp').onclick = () => { parts.push({ category_id: null, amount: Math.max(0, total - parts.reduce((a, p) => a + p.amount, 0)), note: '' }); draw(); };
  m.$('#save').onclick = guard(async () => {
    await PUT('/transactions/' + id + '/split', { parts: parts.map(p => ({ category_id: p.category_id, amount: sign * p.amount, note: p.note })) });
    m.close(); await refreshMeta(); toast('Splitsing opgeslagen'); go(S.tab);
  });
  m.$('#unsplit')?.addEventListener('click', guard(async () => { await DEL('/transactions/' + id + '/split'); m.close(); await refreshMeta(); toast('Splitsing opgeheven'); go(S.tab); }));
  draw();
}

// ---------- spaardoelen ----------
async function renderGoals() {
  const box = $('#goalsbox'); if (!box) return;
  const goals = await GET('/goals');
  box.innerHTML = `<div class="card"><h2>Spaardoelen <span class="right"><a href="#" id="addgoal">+ Doel toevoegen</a></span></h2>${goals.length ? `<div class="grid g4">${goals.map(g => {
    const left = Math.max(0, g.target - g.saved), months = g.monthly > 0 && left > 0 ? Math.ceil(left / g.monthly) : null;
    const eta = months ? new Date(Date.now() + months * 30.44 * 864e5).toLocaleDateString('nl-NL', { month: 'short', year: 'numeric' }) : null;
    return `<div class="card" style="box-shadow:none;background:var(--hover)" data-goal="${g.id}"><div class="row between"><b>${esc(g.icon)} ${esc(g.name)}</b><button class="btn sm ghost" data-edit title="Wijzigen">⋯</button></div>
      <div class="kpi"><div class="v" style="font-size:20px">${eur0(g.saved)}</div><div class="sub">van ${eur0(g.target)} · ${pct(g.saved, g.target)}%</div></div>
      <div style="margin:8px 0">${progressBar(g.saved, g.target).replace('var(--good)', 'var(--accent)')}</div>
      <div class="small muted">${left === 0 ? '🎉 Doel bereikt!' : eta ? `Nog ${eur0(left)} · bij ${eur0(g.monthly)}/mnd klaar in ${eta}` : `Nog ${eur0(left)}`}</div>
      ${left > 0 ? `<button class="btn sm" style="margin-top:8px" data-add>+ Bijstorten</button>` : ''}</div>`; }).join('')}</div>` : '<div class="empty">Spaar je ergens voor? Stel een doel in en volg je voortgang.</div>'}</div>`;
  $('#addgoal').onclick = e => { e.preventDefault(); goalModal(); };
  box.querySelectorAll('[data-goal]').forEach(el => {
    const g = goals.find(x => x.id === +el.dataset.goal);
    el.querySelector('[data-edit]').onclick = () => goalModal(g);
    el.querySelector('[data-add]')?.addEventListener('click', () => {
      const mm = modal(`<h3>Bijstorten op “${esc(g.name)}”</h3><div class="form"><label>Bedrag (€)</label><input id="ga" type="number" min="0" step="0.01" placeholder="0,00"></div><div class="foot"><button class="btn" data-close>Annuleren</button><button class="btn primary" id="go">Bijstorten</button></div>`);
      mm.$('#go').onclick = guard(async () => { const v = Math.round(Number(mm.$('#ga').value) * 100); if (!(v > 0)) return toast('Vul een bedrag in'); await PUT('/goals/' + g.id, { saved: g.saved + v }); mm.close(); toast('Bijgestort'); renderGoals(); });
    });
  });
}
function goalModal(g) {
  const m = modal(`<h3>${g ? 'Doel wijzigen' : 'Nieuw spaardoel'}</h3><div class="form">
    <label>Naam</label><div class="row" style="flex-wrap:nowrap"><input id="gi" value="${esc(g?.icon || '🎯')}" style="width:52px;text-align:center"><input id="gn" value="${esc(g?.name || '')}" placeholder="bijv. Vakantie" style="flex:1"></div>
    <label>Streefbedrag (€)</label><input id="gt" type="number" min="1" step="1" value="${g ? g.target / 100 : ''}">
    <label>Al gespaard (€)</label><input id="gs" type="number" min="0" step="1" value="${g ? g.saved / 100 : 0}">
    <label>Per maand (€)</label><input id="gm" type="number" min="0" step="1" value="${g ? g.monthly / 100 : ''}" placeholder="optioneel"></div>
    <div class="foot">${g ? '<button class="btn danger" id="gd">Verwijderen</button><span style="flex:1"></span>' : ''}<button class="btn" data-close>Annuleren</button><button class="btn primary" id="gsave">Opslaan</button></div>`);
  m.$('#gsave').onclick = guard(async () => {
    const body = { name: m.$('#gn').value, icon: m.$('#gi').value || '🎯', target: Math.round(m.$('#gt').value * 100), saved: Math.round(m.$('#gs').value * 100), monthly: Math.round(m.$('#gm').value * 100) };
    if (g) await PUT('/goals/' + g.id, body); else await POST('/goals', body);
    m.close(); renderGoals();
  });
  m.$('#gd')?.addEventListener('click', guard(async () => { if (await ask('Doel verwijderen?', 'Dit kan niet ongedaan worden gemaakt.', 'Verwijderen', true)) { await DEL('/goals/' + g.id); m.close(); renderGoals(); } }));
}

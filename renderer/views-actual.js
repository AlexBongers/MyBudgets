'use strict';
// Actual-importwizard: bestand kiezen → tabellen/kolommen controleren (live voorbeeld) → categorieën koppelen → importeren.
const ACTUAL = { file: null, tables: [], t: 0, cfg: {}, kind: {}, catMap: {}, accMap: {}, done: {}, plan: null, seq: 0 };
const FIELD_LABELS = [
  ['date', 'Datum', true], ['amount', 'Bedrag', true], ['payee', 'Tegenpartij / naam'], ['description', 'Omschrijving'], ['notes', 'Notities'],
  ['category', 'Categorie'], ['account', 'Rekening'], ['type', 'Type (uitgave/inkomst)'],
];

const srcBody = f => ({ base64: f.base64, name: f.name });
async function loadActualFile(file) {
  const r = await POST('/actual/analyze', srcBody(file));
  Object.assign(ACTUAL, { file, tables: r.tables, t: 0, cfg: {}, kind: {}, catMap: {}, accMap: {}, done: {}, plan: null });
  r.tables.forEach(t => { ACTUAL.kind[t.name] = t.guess.kind === 'unknown' ? 'skip' : t.guess.kind; ACTUAL.cfg[t.name] = { fields: { ...t.guess.fields }, budget: { ...t.guess.budget }, sign: 'auto', dateOrder: t.guess.dateOrder, decimal: t.guess.decimal, enrich: true, defaultAccount: '' }; });
  const first = r.tables.findIndex(t => ACTUAL.kind[t.name] === 'transactions'); ACTUAL.t = first >= 0 ? first : 0;
  go('actual');
}
async function pickActualFile() {
  if (window.native?.openActual) { const f = await window.native.openActual(); if (f.length) await loadActualFile(f[0]); return; }
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.zip,.sqlite,application/zip';
  inp.onchange = guard(async () => { const f = inp.files[0]; if (f) await loadActualFile({ name: f.name, base64: await readFileBase64(f) }); }); inp.click();
}

V.actual = async () => {
  $('#title').textContent = 'Importeren uit Actual Budget';
  if (!ACTUAL.file) return actualStart();
  actualWizard();
};

function actualStart() {
  const m = render(`<div class="grid g21"><div class="stack">
      <div class="dz" id="ndz"><div style="font-size:34px">📦</div><b style="color:var(--text)">Sleep je Actual Budget-export hierheen</b><br>de ZIP met <code>db.sqlite</code> (of de losse db.sqlite)</div>
      <p class="muted small" style="margin:0">Je bestand wordt alleen lokaal gelezen. Je ziet eerst een voorbeeld; er wordt niets opgeslagen voordat je op “Importeren” klikt.</p></div>
    <div class="card"><h2>Exporteren uit Actual Budget</h2><ol class="steps">
      <li>Open je budget in Actual.</li><li>Klik linksonder op je budgetnaam → <b>Settings</b>.</li><li>Kies onder <b>Export</b> voor <b>Export data</b>.</li><li>Sleep de gedownloade ZIP hier in.</li></ol>
      <hr><p class="muted small" style="margin:0">Je transacties, categorieën (met groepen), rekeningen en budgetten komen mee. Staan dezelfde transacties al in MyBudgets (bijv. uit je Rabobank-import), dan krijgen die je Actual-categorie in plaats van dubbel te worden, en leert MyBudgets ervan.</p></div></div>`);
  $('#ndz', m).addEventListener('click', guard(pickActualFile));
}

const tableOf = () => ACTUAL.tables[ACTUAL.t];
const cfgOf = () => ACTUAL.cfg[tableOf().name];

function actualWizard() {
  const tb = tableOf(), cfg = cfgOf(), kind = ACTUAL.kind[tb.name], headers = tb.headers;
  const colSel = (field, v) => `<select data-f="${field}"><option value="">— niet gebruiken —</option>${headers.map(h => `<option ${h === v ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`;
  const hasSplit = !!(cfg.fields.amountIn || cfg.fields.amountOut) && !cfg.fields.amount;
  const m = render(`
    <div class="row between" style="margin-bottom:12px"><div class="row"><span class="chip" style="--c:#6b7280">${'📦'} ${esc(ACTUAL.file.name)}</span><span class="muted small">${ACTUAL.tables.length} tabel${ACTUAL.tables.length === 1 ? '' : 'len'} gevonden</span></div>
      <button class="btn sm" id="nother">Andere bron…</button></div>
    ${ACTUAL.tables.length > 1 ? `<div class="seg" id="ntabs" style="margin-bottom:14px;flex-wrap:wrap">${ACTUAL.tables.map((t, i) => `<button data-i="${i}" class="${i === ACTUAL.t ? 'on' : ''}">${esc(t.name)} <span class="faint">· ${t.rows}${ACTUAL.done[t.name] ? ' ✓' : ''}</span></button>`).join('')}</div>` : ''}
    <div class="card" style="margin-bottom:16px"><div class="row between"><h2 style="margin:0">${esc(tb.name)} <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">· ${tb.rows} rijen</span></h2>
      <div class="seg" id="nkind">${[['transactions', 'Transacties'], ['budgets', 'Budgetten'], ['skip', 'Overslaan']].map(([v, l]) => `<button data-v="${v}" class="${kind === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      ${kind === 'skip' ? '<div class="empty">Deze tabel wordt niet geïmporteerd.</div>' : ''}
      <div class="small muted" style="margin-top:10px;overflow:auto"><table><thead><tr>${headers.slice(0, 8).map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${tb.samples.slice(0, 3).map(r => `<tr>${headers.slice(0, 8).map((_, i) => `<td class="ellipsis" style="max-width:150px">${esc(r[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>
    ${kind === 'skip' ? '' : `<div class="grid g21"><div class="stack">
      <div class="card"><h2>Kolommen koppelen</h2><div class="form" id="nmap">
        ${kind === 'transactions' ? `
          ${FIELD_LABELS.filter(f => !['amount'].includes(f[0])).slice(0, 1).map(([f, l]) => `<label>${l} *</label>${colSel(f, cfg.fields[f])}`).join('')}
          <label>Bedrag *</label><div class="stack" style="gap:6px">${hasSplit ? `<div class="row" style="flex-wrap:nowrap"><span class="small muted" style="width:70px">Uitgaven</span>${colSel('amountOut', cfg.fields.amountOut)}</div><div class="row" style="flex-wrap:nowrap"><span class="small muted" style="width:70px">Inkomsten</span>${colSel('amountIn', cfg.fields.amountIn)}</div>` : colSel('amount', cfg.fields.amount)}
            <a href="#" class="small" id="nsplit">${hasSplit ? 'Eén bedragkolom gebruiken' : 'Aparte kolommen voor uitgaven en inkomsten'}</a></div>
          ${FIELD_LABELS.slice(2).map(([f, l]) => `<label>${l}</label>${colSel(f, cfg.fields[f])}`).join('')}
          <label>Tekens</label><select data-o="sign">${[['auto', 'Automatisch herkennen'], ['as-is', 'Zoals in de tabel (− = uitgave)'], ['expenses-positive', 'Alles is uitgave (positief getal)'], ['by-type', 'Volgens de Type-kolom'], ['invert', 'Omkeren']].map(([v, l]) => `<option value="${v}" ${cfg.sign === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <label>Datumnotatie</label><select data-o="dateOrder"><option value="dmy" ${cfg.dateOrder === 'dmy' ? 'selected' : ''}>dag-maand-jaar (NL)</option><option value="mdy" ${cfg.dateOrder === 'mdy' ? 'selected' : ''}>maand-dag-jaar (US)</option></select>
          <label>Decimalen</label><select data-o="decimal"><option value="," ${cfg.decimal === ',' ? 'selected' : ''}>1.234,56 (komma)</option><option value="." ${cfg.decimal === '.' ? 'selected' : ''}>1,234.56 (punt)</option></select>
          <label>Standaardrekening</label><select data-o="defaultAccount"><option value="">Uit de kolom Rekening</option>${S.accounts.map(a => `<option value="${a.id}" ${String(cfg.defaultAccount) === String(a.id) ? 'selected' : ''}>${esc(a.name)} (${esc(a.iban.slice(-4))})</option>`).join('')}</select>
          <label></label><label class="row small" style="color:var(--text)"><input type="checkbox" data-o="enrich" ${cfg.enrich ? 'checked' : ''}> Bestaande transacties verrijken met de categorie uit Actual</label>`
        : `<label>Categorie *</label>${colSel('category', cfg.fields.category)}<label>Budgetbedrag *</label>${colSel('budgetAmount', cfg.budget.amount)}<label>Maand</label>${colSel('budgetMonth', cfg.budget.month)}
          <label>Decimalen</label><select data-o="decimal"><option value="," ${cfg.decimal === ',' ? 'selected' : ''}>1.234,56 (komma)</option><option value="." ${cfg.decimal === '.' ? 'selected' : ''}>1,234.56 (punt)</option></select>`}
      </div></div>
      <div class="card"><h2>Voorbeeld</h2><div id="nplan"><div class="empty">Bezig…</div></div></div></div>
      <div class="stack"><div class="card" id="nacc" hidden></div><div class="card" id="ncat"></div><div class="card" id="nimport"></div></div></div>`}`);
  $('#nother').onclick = () => { ACTUAL.file = null; V.actual(); };
  $('#ntabs')?.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) { ACTUAL.t = +b.dataset.i; ACTUAL.plan = null; actualWizard(); } });
  $('#nkind').addEventListener('click', e => { const v = e.target.dataset.v; if (v) { ACTUAL.kind[tb.name] = v; ACTUAL.plan = null; actualWizard(); } });
  if (kind === 'skip') return;
  $('#nsplit')?.addEventListener('click', e => { e.preventDefault(); if (hasSplit) { cfg.fields.amountIn = cfg.fields.amountOut = null; } else { cfg.fields.amount = null; } actualWizard(); });
  const refresh = debounce(refreshActualPlan, 220);
  $('#nmap').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.f) { const v = t.value || null; if (t.dataset.f === 'budgetAmount') cfg.budget.amount = v; else if (t.dataset.f === 'budgetMonth') cfg.budget.month = v; else cfg.fields[t.dataset.f] = v; }
    else if (t.dataset.o) cfg[t.dataset.o] = t.type === 'checkbox' ? t.checked : t.value;
    refresh();
  });
  refreshActualPlan();
}

const actualBody = () => { const tb = tableOf(), kind = ACTUAL.kind[tb.name], cfg = cfgOf();
  return { ...srcBody(ACTUAL.file), table: tb.name, kind, config: { ...cfg, defaultAccount: cfg.defaultAccount || null, accountMap: ACTUAL.accMap[tb.name] || {}, categoryMap: ACTUAL.catMap[tb.name] || {} } }; };

async function refreshActualPlan() {
  const seq = ++ACTUAL.seq, box = $('#nplan'); if (!box) return;
  try {
    const p = await POST('/actual/plan', actualBody());
    if (seq !== ACTUAL.seq || !$('#nplan')) return;
    ACTUAL.plan = p; drawActualPlan();
  } catch (e) { if (seq === ACTUAL.seq && $('#nplan')) { box.innerHTML = `<div class="neg small">⚠ ${esc(e.message)}</div>`; $('#ncat').innerHTML = ''; $('#nimport').innerHTML = ''; } }
}

function drawActualPlan() {
  const p = ACTUAL.plan, s = p.summary, tb = tableOf();
  if (p.kind === 'budgets') {
    $('#nplan').innerHTML = `<div class="row small" style="gap:6px 14px;margin-bottom:8px"><span>✅ <b>${s.valid}</b> budgetregels</span>${s.unmatched ? `<span class="neg">⚠ <b>${s.unmatched}</b> zonder categorie</span>` : ''}${s.errors ? `<span class="neg">${s.errors} fouten</span>` : ''}</div>
      <table><tbody>${p.items.map(i => `<tr><td>${esc(i.value)}</td><td class="muted small">${i.month === '2000-01' ? 'vanaf begin' : monthName(i.month)}</td><td class="num">${eur(i.amount)}</td><td>${i.category ? '→ ' + esc(i.category.name) : '<span class="neg small">geen categorie</span>'}</td></tr>`).join('')}</tbody></table>`;
    const unmatched = [...new Set(p.items.filter(i => !i.category).map(i => i.value))];
    $('#ncat').innerHTML = unmatched.length ? `<h2>Categorieën koppelen</h2><div class="stack">${unmatched.map(v => `<div class="row between" style="flex-wrap:nowrap"><span class="ellipsis" style="max-width:150px">${esc(v)}</span>${catSelect(null, { none: '— overslaan —', attrs: `data-bv="${esc(v)}"` })}</div>`).join('')}</div>` : '';
    $('#ncat').onchange = e => { const v = e.target.dataset.bv; if (v == null) return; (ACTUAL.catMap[tb.name] ||= {})[v] = e.target.value ? { type: 'existing', id: +e.target.value } : { type: 'none' }; refreshActualPlan(); };
    drawActualImport(s.valid > 0, `${s.valid} budgetregels importeren`); return;
  }
  const chips = [[s.added, 'nieuw', 'ok'], [s.enrich, 'bestaande verrijkt', 'blue'], [s.already, 'bestaan al', ''], [s.errors, 'overgeslagen (fout)', s.errors ? 'warn' : '']].filter(c => c[0] || c[1] === 'nieuw');
  $('#nplan').innerHTML = `<div class="row" style="gap:6px;margin-bottom:10px">${chips.map(([n, l, c]) => `<span class="tag ${c}" style="font-size:12px;padding:1px 8px"><b>${n}</b> ${l}</span>`).join('')}</div>
    ${s.from ? `<div class="small muted" style="margin-bottom:8px">${fmtDate(s.from)} – ${fmtDate(s.to)} · inkomsten ${eur(s.income)} · uitgaven ${eur(s.expenses)}</div>` : ''}
    <div class="tablewrap"><table><tbody>${p.preview.map(r => `<tr><td class="nowrap muted small">${fmtDay(r.date)}</td><td><div class="tx-name">${esc(r.payee)}</div>${r.description ? `<div class="small muted ellipsis" style="max-width:260px">${esc(r.description)}</div>` : ''}</td><td class="small muted">${esc(r.category || '')}</td><td class="num ${r.amount < 0 ? '' : 'pos'}"><b>${eur(r.amount)}</b></td><td><span class="tag ${r.status === 'nieuw' ? 'ok' : r.status === 'bestaat al' ? '' : 'blue'}">${r.status}</span></td></tr>`).join('')}</tbody></table></div>
    ${s.valid > p.preview.length ? `<div class="small muted" style="margin-top:6px">… en nog ${s.valid - p.preview.length} regels</div>` : ''}
    ${p.errors.length ? `<details style="margin-top:8px"><summary class="neg small">⚠ ${s.errors} regel(s) kunnen niet worden gelezen</summary>${p.errors.map(e => `<div class="small muted">Regel ${e.row}: ${esc(e.reason)}</div>`).join('')}${s.errors > p.errors.length ? '<div class="small muted">…</div>' : ''}</details>` : ''}`;
  // rekening-koppeling
  const nacc = $('#nacc');
  if (nacc) {
    nacc.hidden = !p.accountPlan?.length;
    nacc.innerHTML = p.accountPlan?.length ? `<h2>Rekeningen koppelen <span class="right muted">${p.accountPlan.length} in Actual</span></h2><div class="stack">${p.accountPlan.map((a, i) => {
      const val = a.action.type === 'existing' ? 'e' + a.action.id : 'new';
      return `<div class="stack" style="gap:6px"><div class="row between" style="flex-wrap:nowrap;gap:8px"><span style="min-width:0"><span class="ellipsis" style="display:block;max-width:150px" title="${esc(a.value)}">${esc(a.value)}</span><span class="faint small">${a.count}×</span></span>
        <select data-av="${i}" style="max-width:180px"><option value="new" ${val === 'new' ? 'selected' : ''}>➕ Nieuwe rekening</option>${S.accounts.map(k => `<option value="e${k.id}" ${val === 'e' + k.id ? 'selected' : ''}>${esc(k.name)} (${esc(k.iban.slice(-4))})</option>`).join('')}</select></div>
        ${val === 'new' ? `<input data-ai="${i}" placeholder="IBAN (optioneel, voor latere Rabo-CSV’s)" value="${esc(a.action.iban || '')}" style="width:100%" spellcheck="false">` : ''}</div>`; }).join('')}</div>
      <p class="muted small" style="margin:8px 0 0">Tip: vul het echte IBAN in, dan landen je volgende Rabobank-CSV’s op dezelfde rekening.</p>` : '';
    const setAcc = (i, v, iban) => { const a = p.accountPlan[+i]; (ACTUAL.accMap[tb.name] ||= {})[a.value] = v === 'new' ? { type: 'new', name: a.value, iban } : { type: 'existing', id: +v.slice(1) }; };
    nacc.onchange = e => { const t = e.target; if (t.dataset.av != null) { setAcc(t.dataset.av, t.value, ''); refreshActualPlan(); } else if (t.dataset.ai != null) { setAcc(t.dataset.ai, 'new', t.value.trim()); refreshActualPlan(); } };
  }
  // categorie-koppeling
  const cats = S.cats;
  $('#ncat').innerHTML = p.categoryPlan.length ? `<h2>Categorieën koppelen <span class="right muted">${p.categoryPlan.length} in Actual</span></h2><div class="stack" style="max-height:340px;overflow:auto">${p.categoryPlan.map((c, i) => {
    const a = c.action, val = a.type === 'existing' ? 'e' + a.id : a.type === 'none' ? 'none' : 'new';
    return `<div class="row between" style="flex-wrap:nowrap;gap:8px"><span style="min-width:0"><span class="ellipsis" style="display:block;max-width:150px" title="${esc(c.value)}">${esc(c.value)}</span><span class="faint small">${c.count}×${a.auto ? '' : ' · jouw keuze'}</span></span>
      <select data-cv="${i}" style="max-width:170px"><option value="new" ${val === 'new' ? 'selected' : ''}>➕ Nieuw: ${esc(a.type === 'new' ? a.name : c.value)}</option><option value="none" ${val === 'none' ? 'selected' : ''}>— geen categorie —</option>${cats.map(k => `<option value="e${k.id}" ${val === 'e' + k.id ? 'selected' : ''}>${k.icon} ${esc(k.name)}</option>`).join('')}</select></div>`; }).join('')}</div>` : '';
  $('#ncat').onchange = e => { const i = e.target.dataset.cv; if (i == null) return; const c = p.categoryPlan[+i], v = e.target.value;
    (ACTUAL.catMap[tb.name] ||= {})[c.value] = v === 'none' ? { type: 'none' } : v === 'new' ? { type: 'new', name: c.value, kind: c.action.kind || 'expense' } : { type: 'existing', id: +v.slice(1) }; refreshActualPlan(); };
  drawActualImport(s.valid > 0, s.added + s.enrich ? `${s.added} toevoegen${s.enrich ? ` · ${s.enrich} verrijken` : ''}` : 'Niets nieuws om te importeren', s.added + s.enrich > 0);
}

function drawActualImport(canImport, label, hasWork = true) {
  const tb = tableOf();
  $('#nimport').innerHTML = `<button class="btn primary" id="ngo" style="width:100%;padding:8px" ${canImport && hasWork ? '' : 'disabled'}>${esc(label)}</button>
    <p class="muted small" style="margin:8px 0 0">Elke import staat in de importgeschiedenis en is terug te draaien. De app leert van de categorieën die je meebrengt.</p>`;
  $('#ngo').onclick = guard(async () => {
    $('#ngo').disabled = true; $('#ngo').textContent = 'Bezig met importeren…';
    const r = await POST('/actual/import', actualBody());
    ACTUAL.done[tb.name] = true; await refreshMeta(); S.month = null;
    showActualResult(r);
  });
}

function showActualResult(r) {
  const next = ACTUAL.tables.findIndex((t, i) => !ACTUAL.done[t.name] && ACTUAL.kind[t.name] !== 'skip');
  const lines = r.kind === 'budgets' ? [`✅ <b>${r.budgets}</b> budgetregels geïmporteerd${r.skipped ? `, ${r.skipped} overgeslagen` : ''}`]
    : [`✅ <b>${r.added}</b> transacties toegevoegd`, r.enriched ? `🔗 <b>${r.enriched}</b> bestaande transacties verrijkt met je Actual-categorie` : '', r.createdCategories ? `🏷️ <b>${r.createdCategories}</b> nieuwe categorie${r.createdCategories === 1 ? '' : 'ën'} aangemaakt` : '',
      r.learned ? `🧠 De app leerde van <b>${r.learned}</b> indelingen en past dat toe op toekomstige imports` : '', r.skipped ? `<span class="muted">${r.skipped} stonden al in MyBudgets</span>` : '', r.errors ? `<span class="muted">${r.errors} regels overgeslagen (niet leesbaar)</span>` : ''].filter(Boolean);
  render(`<div class="hero" style="margin-top:4vh"><div class="big">🎉</div><h2>Import klaar</h2><div class="card" style="text-align:left"><div class="stack">${lines.map(l => `<div>${l}</div>`).join('')}</div></div>
    <div class="row" style="justify-content:center;margin-top:18px">${next >= 0 ? `<button class="btn primary" id="nnext">Volgende tabel: ${esc(ACTUAL.tables[next].name)}</button>` : ''}<button class="btn ${next >= 0 ? '' : 'primary'}" data-go="dashboard">Naar dashboard</button>${S.review ? `<button class="btn" data-go="review">${S.review} beoordelen</button>` : ''}<button class="btn" data-go="settings">Importgeschiedenis</button></div></div>`);
  $$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  $('#nnext')?.addEventListener('click', () => { ACTUAL.t = next; ACTUAL.plan = null; go('actual'); });
}

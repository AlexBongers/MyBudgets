'use strict';
// Notion-importwizard: bestand kiezen → tabellen/kolommen controleren (live voorbeeld) → categorieën koppelen → importeren.
const NOTION = { file: null, tables: [], t: 0, cfg: {}, kind: {}, catMap: {}, done: {}, plan: null, seq: 0 };
const FIELD_LABELS = [
  ['date', 'Datum', true], ['amount', 'Bedrag', true], ['payee', 'Tegenpartij / naam'], ['description', 'Omschrijving'], ['notes', 'Notities'],
  ['category', 'Categorie'], ['account', 'Rekening'], ['type', 'Type (uitgave/inkomst)'],
];

const srcBody = f => (f.apiToken ? { apiToken: f.apiToken, databaseIds: f.databaseIds, name: f.name } : { base64: f.base64, name: f.name });
async function loadNotionFile(file) {
  const r = await POST('/notion/analyze', srcBody(file));
  Object.assign(NOTION, { file, tables: r.tables, t: 0, cfg: {}, kind: {}, catMap: {}, done: {}, plan: null });
  r.tables.forEach(t => { NOTION.kind[t.name] = t.guess.kind === 'unknown' ? 'skip' : t.guess.kind; NOTION.cfg[t.name] = { fields: { ...t.guess.fields }, budget: { ...t.guess.budget }, sign: 'auto', dateOrder: t.guess.dateOrder, decimal: t.guess.decimal, enrich: true, defaultAccount: '' }; });
  const first = r.tables.findIndex(t => NOTION.kind[t.name] === 'transactions'); NOTION.t = first >= 0 ? first : 0;
  go('notion');
}
async function pickNotionFile() {
  if (window.native?.openNotion) { const f = await window.native.openNotion(); if (f.length) await loadNotionFile(f[0]); return; }
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.zip,.csv,text/csv,application/zip';
  inp.onchange = guard(async () => { const f = inp.files[0]; if (f) await loadNotionFile({ name: f.name, base64: await readFileBase64(f) }); }); inp.click();
}

V.notion = async () => {
  $('#title').textContent = 'Importeren uit Notion';
  if (!NOTION.file) return notionStart();
  notionWizard();
};

function notionStart() {
  const m = render(`<div class="grid g21"><div class="stack">
      <div class="dz" id="ndz"><div style="font-size:34px">🗂️</div><b style="color:var(--text)">Sleep je Notion-export hierheen</b><br>ZIP (“Markdown &amp; CSV”) of een losse CSV van je database</div>
      <p class="muted small" style="margin:0">Je bestand wordt alleen lokaal gelezen. Je ziet eerst een voorbeeld; er wordt niets opgeslagen voordat je op “Importeren” klikt.</p>
      <div class="card"><h2>Of: rechtstreeks verbinden met Notion</h2>
        <ol class="steps small"><li>Maak op <b>notion.so/my-integrations</b> een integratie en kopieer het geheime token.</li><li>Open je database in Notion → <b>⋯ → Connections</b> → voeg je integratie toe.</li><li>Plak het token hieronder.</li></ol>
        <div class="row" style="flex-wrap:nowrap"><input type="password" id="ntoken" placeholder="secret_… of ntn_…" autocomplete="off" spellcheck="false" style="flex:1"><button class="btn" id="nconnect">Verbinden</button></div>
        ${window.native?.secret ? '<label class="row small muted" style="margin-top:8px"><input type="checkbox" id="nremember" checked> Token versleuteld onthouden (Sleutelhanger)</label>' : ''}
        <div id="ndbs" style="margin-top:12px"></div></div></div>
    <div class="card"><h2>Exporteren uit Notion</h2><ol class="steps">
      <li>Open je budget-database (of de hele pagina met alle databases).</li>
      <li>Klik op <b>⋯</b> → <b>Export</b>.</li>
      <li>Kies <b>Markdown &amp; CSV</b> en zet <b>Include subpages</b> aan (voor meerdere databases tegelijk).</li>
      <li>Download de ZIP en sleep hem hier in.</li></ol>
      <hr><p class="muted small" style="margin:0"><b>Slim:</b> importeer eerst je Rabobank-CSV’s. Dan worden je Notion-categorieën aan de echte bankboekingen gehangen in plaats van dubbel te worden, en leert MyBudgets ervan.</p></div></div>`);
  $('#ndz', m).addEventListener('click', guard(pickNotionFile));
  const connect = guard(async token => {
    const box = $('#ndbs'); box.innerHTML = '<span class="muted small">Verbinden…</span>';
    let r; try { r = await POST('/notion/api/databases', { token }); } catch (e) { box.innerHTML = `<div class="neg small">⚠ ${esc(e.message)}</div>`; return; }
    if (window.native?.secret && $('#nremember')?.checked) window.native.secret.set(token);
    if (!r.databases.length) { box.innerHTML = '<div class="small neg">Verbonden, maar er is geen database met je integratie gedeeld. Open je database → ⋯ → Connections → voeg de integratie toe.</div>'; return; }
    box.innerHTML = `<div class="small muted" style="margin-bottom:6px">${r.databases.length} database${r.databases.length === 1 ? '' : 's'} gevonden. Kies wat je wilt importeren:</div><div class="stack" style="max-height:220px;overflow:auto;gap:6px">${r.databases.map(d => `<label class="row" style="flex-wrap:nowrap"><input type="checkbox" value="${esc(d.id)}" data-t="${esc(d.title)}"> <span>${esc(d.title)}</span> <span class="faint small">${d.properties} kolommen</span></label>`).join('')}</div>
      <button class="btn primary" id="nload" style="margin-top:10px" disabled>Laden…</button>`;
    const upd = () => { const n = $$('#ndbs input[type=checkbox]:checked').length; $('#nload').disabled = !n; $('#nload').textContent = n ? `${n} database${n === 1 ? '' : 's'} laden` : 'Laden…'; };
    box.addEventListener('change', upd);
    $('#nload').onclick = guard(async () => {
      const picked = $$('#ndbs input:checked'); $('#nload').textContent = 'Ophalen uit Notion…'; $('#nload').disabled = true;
      await loadNotionFile({ name: 'Notion (' + picked.map(i => i.dataset.t).join(', ').slice(0, 60) + ')', apiToken: token, databaseIds: picked.map(i => i.value) });
    });
  });
  $('#nconnect', m).onclick = () => { const t = $('#ntoken').value.trim(); if (t) connect(t); else toast('Plak eerst je Notion-token'); };
  $('#ntoken', m).addEventListener('keydown', e => { if (e.key === 'Enter') $('#nconnect').click(); });
  if (window.native?.secret) window.native.secret.get().then(t => { if (t && $('#ntoken')) { $('#ntoken').value = t; connect(t); } });
}

const tableOf = () => NOTION.tables[NOTION.t];
const cfgOf = () => NOTION.cfg[tableOf().name];

function notionWizard() {
  const tb = tableOf(), cfg = cfgOf(), kind = NOTION.kind[tb.name], headers = tb.headers;
  const colSel = (field, v) => `<select data-f="${field}"><option value="">— niet gebruiken —</option>${headers.map(h => `<option ${h === v ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`;
  const hasSplit = !!(cfg.fields.amountIn || cfg.fields.amountOut) && !cfg.fields.amount;
  const m = render(`
    <div class="row between" style="margin-bottom:12px"><div class="row"><span class="chip" style="--c:#6b7280">${NOTION.file.apiToken ? '🔌' : '🗂️'} ${esc(NOTION.file.name)}</span><span class="muted small">${NOTION.tables.length} tabel${NOTION.tables.length === 1 ? '' : 'len'} gevonden</span></div>
      <button class="btn sm" id="nother">Andere bron…</button></div>
    ${NOTION.tables.length > 1 ? `<div class="seg" id="ntabs" style="margin-bottom:14px;flex-wrap:wrap">${NOTION.tables.map((t, i) => `<button data-i="${i}" class="${i === NOTION.t ? 'on' : ''}">${esc(t.name)} <span class="faint">· ${t.rows}${NOTION.done[t.name] ? ' ✓' : ''}</span></button>`).join('')}</div>` : ''}
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
          <label>Standaardrekening</label><select data-o="defaultAccount"><option value="">Nieuwe rekening “Notion” of uit kolom</option>${S.accounts.map(a => `<option value="${a.id}" ${String(cfg.defaultAccount) === String(a.id) ? 'selected' : ''}>${esc(a.name)} (${esc(a.iban.slice(-4))})</option>`).join('')}</select>
          <label></label><label class="row small" style="color:var(--text)"><input type="checkbox" data-o="enrich" ${cfg.enrich ? 'checked' : ''}> Bestaande transacties verrijken met de categorie uit Notion</label>`
        : `<label>Categorie *</label>${colSel('category', cfg.fields.category)}<label>Budgetbedrag *</label>${colSel('budgetAmount', cfg.budget.amount)}<label>Maand</label>${colSel('budgetMonth', cfg.budget.month)}
          <label>Decimalen</label><select data-o="decimal"><option value="," ${cfg.decimal === ',' ? 'selected' : ''}>1.234,56 (komma)</option><option value="." ${cfg.decimal === '.' ? 'selected' : ''}>1,234.56 (punt)</option></select>`}
      </div></div>
      <div class="card"><h2>Voorbeeld</h2><div id="nplan"><div class="empty">Bezig…</div></div></div></div>
      <div class="stack"><div class="card" id="ncat"></div><div class="card" id="nimport"></div></div></div>`}`);
  $('#nother').onclick = () => { NOTION.file = null; V.notion(); };
  $('#ntabs')?.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) { NOTION.t = +b.dataset.i; NOTION.plan = null; notionWizard(); } });
  $('#nkind').addEventListener('click', e => { const v = e.target.dataset.v; if (v) { NOTION.kind[tb.name] = v; NOTION.plan = null; notionWizard(); } });
  if (kind === 'skip') return;
  $('#nsplit')?.addEventListener('click', e => { e.preventDefault(); if (hasSplit) { cfg.fields.amountIn = cfg.fields.amountOut = null; } else { cfg.fields.amount = null; } notionWizard(); });
  const refresh = debounce(refreshNotionPlan, 220);
  $('#nmap').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.f) { const v = t.value || null; if (t.dataset.f === 'budgetAmount') cfg.budget.amount = v; else if (t.dataset.f === 'budgetMonth') cfg.budget.month = v; else cfg.fields[t.dataset.f] = v; }
    else if (t.dataset.o) cfg[t.dataset.o] = t.type === 'checkbox' ? t.checked : t.value;
    refresh();
  });
  refreshNotionPlan();
}

const notionBody = () => { const tb = tableOf(), kind = NOTION.kind[tb.name], cfg = cfgOf();
  return { ...srcBody(NOTION.file), table: tb.name, kind, config: { ...cfg, defaultAccount: cfg.defaultAccount || null, categoryMap: NOTION.catMap[tb.name] || {} } }; };

async function refreshNotionPlan() {
  const seq = ++NOTION.seq, box = $('#nplan'); if (!box) return;
  try {
    const p = await POST('/notion/plan', notionBody());
    if (seq !== NOTION.seq || !$('#nplan')) return;
    NOTION.plan = p; drawNotionPlan();
  } catch (e) { if (seq === NOTION.seq && $('#nplan')) { box.innerHTML = `<div class="neg small">⚠ ${esc(e.message)}</div>`; $('#ncat').innerHTML = ''; $('#nimport').innerHTML = ''; } }
}

function drawNotionPlan() {
  const p = NOTION.plan, s = p.summary, tb = tableOf();
  if (p.kind === 'budgets') {
    $('#nplan').innerHTML = `<div class="row small" style="gap:6px 14px;margin-bottom:8px"><span>✅ <b>${s.valid}</b> budgetregels</span>${s.unmatched ? `<span class="neg">⚠ <b>${s.unmatched}</b> zonder categorie</span>` : ''}${s.errors ? `<span class="neg">${s.errors} fouten</span>` : ''}</div>
      <table><tbody>${p.items.map(i => `<tr><td>${esc(i.value)}</td><td class="muted small">${i.month === '2000-01' ? 'vanaf begin' : monthName(i.month)}</td><td class="num">${eur(i.amount)}</td><td>${i.category ? '→ ' + esc(i.category.name) : '<span class="neg small">geen categorie</span>'}</td></tr>`).join('')}</tbody></table>`;
    const unmatched = [...new Set(p.items.filter(i => !i.category).map(i => i.value))];
    $('#ncat').innerHTML = unmatched.length ? `<h2>Categorieën koppelen</h2><div class="stack">${unmatched.map(v => `<div class="row between" style="flex-wrap:nowrap"><span class="ellipsis" style="max-width:150px">${esc(v)}</span>${catSelect(null, { none: '— overslaan —', attrs: `data-bv="${esc(v)}"` })}</div>`).join('')}</div>` : '';
    $('#ncat').onchange = e => { const v = e.target.dataset.bv; if (v == null) return; (NOTION.catMap[tb.name] ||= {})[v] = e.target.value ? { type: 'existing', id: +e.target.value } : { type: 'none' }; refreshNotionPlan(); };
    drawNotionImport(s.valid > 0, `${s.valid} budgetregels importeren`); return;
  }
  const chips = [[s.added, 'nieuw', 'ok'], [s.enrich, 'bestaande verrijkt', 'blue'], [s.already, 'bestaan al', ''], [s.errors, 'overgeslagen (fout)', s.errors ? 'warn' : '']].filter(c => c[0] || c[1] === 'nieuw');
  $('#nplan').innerHTML = `<div class="row" style="gap:6px;margin-bottom:10px">${chips.map(([n, l, c]) => `<span class="tag ${c}" style="font-size:12px;padding:1px 8px"><b>${n}</b> ${l}</span>`).join('')}</div>
    ${s.from ? `<div class="small muted" style="margin-bottom:8px">${fmtDate(s.from)} – ${fmtDate(s.to)} · inkomsten ${eur(s.income)} · uitgaven ${eur(s.expenses)}</div>` : ''}
    <div class="tablewrap"><table><tbody>${p.preview.map(r => `<tr><td class="nowrap muted small">${fmtDay(r.date)}</td><td><div class="tx-name">${esc(r.payee)}</div>${r.description ? `<div class="small muted ellipsis" style="max-width:260px">${esc(r.description)}</div>` : ''}</td><td class="small muted">${esc(r.category || '')}</td><td class="num ${r.amount < 0 ? '' : 'pos'}"><b>${eur(r.amount)}</b></td><td><span class="tag ${r.status === 'nieuw' ? 'ok' : r.status === 'bestaat al' ? '' : 'blue'}">${r.status}</span></td></tr>`).join('')}</tbody></table></div>
    ${s.valid > p.preview.length ? `<div class="small muted" style="margin-top:6px">… en nog ${s.valid - p.preview.length} regels</div>` : ''}
    ${p.errors.length ? `<details style="margin-top:8px"><summary class="neg small">⚠ ${s.errors} regel(s) kunnen niet worden gelezen</summary>${p.errors.map(e => `<div class="small muted">Regel ${e.row}: ${esc(e.reason)}</div>`).join('')}${s.errors > p.errors.length ? '<div class="small muted">…</div>' : ''}</details>` : ''}`;
  // categorie-koppeling
  const cats = S.cats;
  $('#ncat').innerHTML = p.categoryPlan.length ? `<h2>Categorieën koppelen <span class="right muted">${p.categoryPlan.length} in Notion</span></h2><div class="stack" style="max-height:340px;overflow:auto">${p.categoryPlan.map((c, i) => {
    const a = c.action, val = a.type === 'existing' ? 'e' + a.id : a.type === 'none' ? 'none' : 'new';
    return `<div class="row between" style="flex-wrap:nowrap;gap:8px"><span style="min-width:0"><span class="ellipsis" style="display:block;max-width:150px" title="${esc(c.value)}">${esc(c.value)}</span><span class="faint small">${c.count}×${a.auto ? '' : ' · jouw keuze'}</span></span>
      <select data-cv="${i}" style="max-width:170px"><option value="new" ${val === 'new' ? 'selected' : ''}>➕ Nieuw: ${esc(a.type === 'new' ? a.name : c.value)}</option><option value="none" ${val === 'none' ? 'selected' : ''}>— geen categorie —</option>${cats.map(k => `<option value="e${k.id}" ${val === 'e' + k.id ? 'selected' : ''}>${k.icon} ${esc(k.name)}</option>`).join('')}</select></div>`; }).join('')}</div>` : '';
  $('#ncat').onchange = e => { const i = e.target.dataset.cv; if (i == null) return; const c = p.categoryPlan[+i], v = e.target.value;
    (NOTION.catMap[tb.name] ||= {})[c.value] = v === 'none' ? { type: 'none' } : v === 'new' ? { type: 'new', name: c.value, kind: c.action.kind || 'expense' } : { type: 'existing', id: +v.slice(1) }; refreshNotionPlan(); };
  drawNotionImport(s.valid > 0, s.added + s.enrich ? `${s.added} toevoegen${s.enrich ? ` · ${s.enrich} verrijken` : ''}` : 'Niets nieuws om te importeren', s.added + s.enrich > 0);
}

function drawNotionImport(canImport, label, hasWork = true) {
  const tb = tableOf();
  $('#nimport').innerHTML = `<button class="btn primary" id="ngo" style="width:100%;padding:8px" ${canImport && hasWork ? '' : 'disabled'}>${esc(label)}</button>
    <p class="muted small" style="margin:8px 0 0">Elke import staat in de importgeschiedenis en is terug te draaien. De app leert van de categorieën die je meebrengt.</p>`;
  $('#ngo').onclick = guard(async () => {
    $('#ngo').disabled = true; $('#ngo').textContent = 'Bezig met importeren…';
    const r = await POST('/notion/import', notionBody());
    NOTION.done[tb.name] = true; await refreshMeta(); S.month = null;
    showNotionResult(r);
  });
}

function showNotionResult(r) {
  const next = NOTION.tables.findIndex((t, i) => !NOTION.done[t.name] && NOTION.kind[t.name] !== 'skip');
  const lines = r.kind === 'budgets' ? [`✅ <b>${r.budgets}</b> budgetregels geïmporteerd${r.skipped ? `, ${r.skipped} overgeslagen` : ''}`]
    : [`✅ <b>${r.added}</b> transacties toegevoegd`, r.enriched ? `🔗 <b>${r.enriched}</b> bestaande transacties verrijkt met je Notion-categorie` : '', r.createdCategories ? `🏷️ <b>${r.createdCategories}</b> nieuwe categorie${r.createdCategories === 1 ? '' : 'ën'} aangemaakt` : '',
      r.learned ? `🧠 De app leerde van <b>${r.learned}</b> indelingen en past dat toe op toekomstige imports` : '', r.skipped ? `<span class="muted">${r.skipped} stonden al in MyBudgets</span>` : '', r.errors ? `<span class="muted">${r.errors} regels overgeslagen (niet leesbaar)</span>` : ''].filter(Boolean);
  render(`<div class="hero" style="margin-top:4vh"><div class="big">🎉</div><h2>Import klaar</h2><div class="card" style="text-align:left"><div class="stack">${lines.map(l => `<div>${l}</div>`).join('')}</div></div>
    <div class="row" style="justify-content:center;margin-top:18px">${next >= 0 ? `<button class="btn primary" id="nnext">Volgende tabel: ${esc(NOTION.tables[next].name)}</button>` : ''}<button class="btn ${next >= 0 ? '' : 'primary'}" data-go="dashboard">Naar dashboard</button>${S.review ? `<button class="btn" data-go="review">${S.review} beoordelen</button>` : ''}<button class="btn" data-go="settings">Importgeschiedenis</button></div></div>`);
  $$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  $('#nnext')?.addEventListener('click', () => { NOTION.t = next; NOTION.plan = null; go('notion'); });
}

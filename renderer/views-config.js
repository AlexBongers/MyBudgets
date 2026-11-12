'use strict';
// ---------- Categorieën, regels, geheugen ----------
V.categories = async () => {
  const tab = S.catTab || 'categories';
  const head = `<div class="row between" style="margin-bottom:14px"><div class="seg" id="ctab">${[['categories', 'Categorieën'], ['rules', 'Regels'], ['memory', 'Geheugen'], ['how', 'Hoe werkt het?']].map(([v, l]) => `<button data-v="${v}" class="${tab === v ? 'on' : ''}">${l}</button>`).join('')}</div><div id="tabactions" class="row"></div></div>`;
  const m = render(head + '<div id="tabbody"></div>');
  $('#ctab').addEventListener('click', e => { if (e.target.dataset.v) { S.catTab = e.target.dataset.v; V.categories(); } });
  await ({ categories: catTab, rules: rulesTab, memory: memoryTab, how: howTab }[tab])();
};

async function catTab() {
  const kinds = { income: 'Inkomen', expense: 'Uitgaven', transfer: 'Overboekingen (tellen niet mee)' };
  const groups = [...new Set(S.cats.map(c => c.grp))];
  $('#tabbody').innerHTML = `<div class="card" style="padding:0"><div class="tablewrap"><table><thead><tr><th></th><th>Naam</th><th>Groep</th><th>Soort</th><th>Kleur</th><th></th></tr></thead><tbody>
    ${S.cats.map(c => `<tr data-id="${c.id}"><td><input data-f="icon" value="${esc(c.icon)}" style="width:44px;text-align:center" maxlength="4"></td><td><input data-f="name" value="${esc(c.name)}" style="width:200px"></td>
      <td><input data-f="grp" list="grps" value="${esc(c.grp)}" style="width:150px"></td>
      <td><select data-f="kind">${Object.entries(kinds).map(([k, l]) => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input type="color" data-f="color" value="${c.color}"></td><td class="num"><button class="btn sm danger" data-del>✕</button></td></tr>`).join('')}</tbody></table></div></div>
    <datalist id="grps">${groups.map(g => `<option value="${esc(g)}">`).join('')}</datalist>
    <form class="card row" id="newcat" style="margin-top:16px"><b>Nieuwe categorie</b><input name="icon" value="🏷️" style="width:48px;text-align:center"><input name="name" placeholder="Naam" required><input name="grp" list="grps" placeholder="Groep" value="Overig" style="width:140px">
      <select name="kind"><option value="expense">Uitgave</option><option value="income">Inkomen</option><option value="transfer">Overboeking</option></select><input type="color" name="color" value="#6b7280"><button class="btn primary">Toevoegen</button></form>`;
  $$('#tabbody tr[data-id]').forEach(tr => {
    const id = +tr.dataset.id;
    tr.addEventListener('change', guard(async e => { const f = e.target.dataset.f; if (!f) return; await PUT('/categories/' + id, { [f]: e.target.value }); await refreshMeta(); toast('Opgeslagen'); }));
    tr.querySelector('[data-del]').addEventListener('click', guard(async () => {
      if (await ask('Categorie verwijderen?', `“${esc(catById(id).name)}” wordt verwijderd. Bijbehorende transacties komen terug in “Te beoordelen”; budgetten, regels en geheugen voor deze categorie verdwijnen.`, 'Verwijderen', true)) { await DEL('/categories/' + id); await refreshMeta(); V.categories(); }
    }));
  });
  $('#newcat').addEventListener('submit', guard(async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); await POST('/categories', f); await refreshMeta(); toast('Categorie toegevoegd'); V.categories(); }));
}

async function rulesTab() {
  const rules = await GET('/rules');
  $('#tabactions').innerHTML = `<button class="btn" id="recat">↻ Alles opnieuw categoriseren</button><button class="btn primary" id="newrule">Nieuwe regel…</button>`;
  $('#tabbody').innerHTML = rules.length ? `<div class="card" style="padding:0"><div class="tablewrap"><table><thead><tr><th style="width:36px"></th><th>Voorwaarde</th><th>Categorie</th><th class="num">Prioriteit</th><th></th></tr></thead><tbody>
    ${rules.map(r => `<tr data-id="${r.id}" style="${r.enabled ? '' : 'opacity:.5'}"><td><input type="checkbox" data-toggle ${r.enabled ? 'checked' : ''} title="Aan/uit"></td><td>${esc(r.description)}</td><td>${r.icon} ${esc(r.category)}</td><td class="num">${r.priority}</td>
      <td class="num nowrap"><button class="btn sm" data-edit>Wijzig</button> <button class="btn sm danger" data-del>✕</button></td></tr>`).join('')}</tbody></table></div></div>
    <p class="muted small">Regels gaan vóór alles. Bij gelijke prioriteit wint de meest specifieke (langste) tekst. Handmatig bevestigde transacties blijven altijd zoals je ze hebt ingedeeld.</p>`
    : `<div class="card empty">Nog geen eigen regels.<br>Maak er een voor tegenpartijen die je zelf wilt sturen, bijvoorbeeld “Albert Heijn boven €100 → Overig”.</div>`;
  $('#newrule').onclick = () => ruleModal();
  $('#recat').onclick = guard(async () => { const r = await POST('/recategorize'); await refreshMeta(); toast(`${r.changed} transactie(s) opnieuw ingedeeld`); });
  $$('#tabbody tr[data-id]').forEach(tr => { const rule = rules.find(r => r.id === +tr.dataset.id);
    tr.querySelector('[data-edit]').onclick = () => ruleModal(rule);
    tr.querySelector('[data-toggle]').onchange = guard(async e => { await PUT('/rules/' + rule.id, { ...rule, enabled: e.target.checked ? 1 : 0 }); await refreshMeta(); V.categories(); });
    tr.querySelector('[data-del]').onclick = guard(async () => { await DEL('/rules/' + rule.id); await refreshMeta(); V.categories(); }); });
}

function ruleModal(rule, prefill) {
  const r = Object.assign({ field: 'payee', op: 'contains', pattern: '', direction: 'any', amount_min: null, amount_max: null, priority: 0, enabled: 1, category_id: null }, prefill || {}, rule || {});
  const sel = (id, opts, v) => `<select id="${id}">${opts.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const m = modal(`<h3>${rule ? 'Regel wijzigen' : 'Nieuwe regel'}</h3><div class="form">
    <label>Als</label><div class="row" style="flex-wrap:nowrap">${sel('rf', [['payee', 'tegenpartij'], ['description', 'omschrijving'], ['iban', 'tegenrekening (IBAN)'], ['any', 'alles']], r.field)}${sel('ro', [['contains', 'bevat'], ['equals', 'is gelijk aan'], ['startswith', 'begint met'], ['regex', 'regex']], r.op)}</div>
    <label>Tekst</label><input id="rp" value="${esc(r.pattern)}" placeholder="bijv. albert heijn">
    <label>Richting</label>${sel('rd', [['any', 'inkomend en uitgaand'], ['out', 'alleen uitgaand (af)'], ['in', 'alleen inkomend (bij)']], r.direction)}
    <label>Bedrag tussen</label><div class="row" style="flex-wrap:nowrap"><input id="rmin" type="number" min="0" step="0.01" placeholder="min €" value="${r.amount_min != null ? r.amount_min / 100 : ''}" style="width:100px"> en <input id="rmax" type="number" min="0" step="0.01" placeholder="max €" value="${r.amount_max != null ? r.amount_max / 100 : ''}" style="width:100px"></div>
    <label>Dan categorie</label>${catSelect(r.category_id, { none: '— kies —', attrs: 'id="rc"' })}
    <label>Prioriteit</label><input id="rpr" type="number" value="${r.priority}" style="width:80px" title="Hoger gaat voor">
  </div><div id="rprev" class="card small" style="margin-top:14px;background:var(--hover);box-shadow:none"></div>
  <div class="foot"><button class="btn" data-close>Annuleren</button><button class="btn primary" id="rs">Opslaan</button></div>`, { wide: true });
  const body = () => ({ field: m.$('#rf').value, op: m.$('#ro').value, pattern: m.$('#rp').value, direction: m.$('#rd').value,
    amount_min: m.$('#rmin').value === '' ? null : Math.round(m.$('#rmin').value * 100), amount_max: m.$('#rmax').value === '' ? null : Math.round(m.$('#rmax').value * 100),
    priority: Number(m.$('#rpr').value) || 0, enabled: r.enabled, category_id: Number(m.$('#rc').value) || null });
  const preview = debounce(async () => {
    const b = body(); const el = m.$('#rprev');
    if (!b.pattern && b.amount_min == null && b.amount_max == null && b.direction === 'any') { el.textContent = 'Vul een voorwaarde in om te zien welke transacties matchen.'; return; }
    try { const p = await POST('/rules/preview', b); el.innerHTML = `<b>${p.count}</b> transactie${p.count === 1 ? '' : 's'} komt${p.count === 1 ? '' : 'en'} overeen.` + p.samples.map(s => `<div class="muted">${fmtDay(s.date)} · ${esc(s.payee)} · ${eur(s.amount)}</div>`).join(''); }
    catch (e) { el.textContent = '⚠ ' + e.message; }
  }, 250);
  m.el.addEventListener('input', preview); m.el.addEventListener('change', preview); preview();
  m.$('#rs').onclick = guard(async () => {
    const b = body(); if (!b.category_id) return toast('Kies een categorie');
    const res = rule ? await PUT('/rules/' + rule.id, b) : await POST('/rules', b);
    m.close(); await refreshMeta(); toast(`Regel opgeslagen · ${res.recategorized} transactie(s) opnieuw ingedeeld`); if (S.tab === 'categories') V.categories(); else go(S.tab);
  });
}

async function memoryTab() {
  const mem = await GET('/memory');
  $('#tabbody').innerHTML = mem.length ? `<p class="muted">Wat MyBudgets van jouw keuzes heeft geleerd. Elke keer dat je een transactie indeelt, onthoudt de app de tegenpartij. Corrigeer je een keuze, dan weegt de nieuwe categorie zwaarder.</p>
    <div class="card" style="padding:0"><div class="tablewrap"><table><thead><tr><th>Tegenpartij / IBAN</th><th>Categorie</th><th class="num">Keer gekozen</th><th></th></tr></thead><tbody>
    ${mem.map(x => `<tr><td>${esc(x.label || x.key)} <span class="faint small">${x.key.startsWith('i:') ? 'IBAN' : ''}</span></td><td>${x.icon} ${esc(x.category)}</td><td class="num">${x.n}</td><td class="num"><button class="btn sm" data-forget="${esc(x.key)}">Vergeet</button></td></tr>`).join('')}</tbody></table></div></div>`
    : `<div class="card empty">Nog niets geleerd. Deel transacties in via “Te beoordelen” en het geheugen vult zich vanzelf.</div>`;
  $$('[data-forget]').forEach(b => b.onclick = guard(async () => { await DEL('/memory?key=' + encodeURIComponent(b.dataset.forget)); await refreshMeta(); V.categories(); }));
}

function howTab() {
  $('#tabbody').innerHTML = `<div class="card"><h2>Hoe MyBudgets categoriseert</h2>
    <p>Bij elke import loopt een transactie langs onderstaande lagen. De eerste laag die iets herkent wint. Alles met een zekerheid onder 80% belandt in <b>Te beoordelen</b>.</p>
    <ol class="steps">
      <li><b>Jouw regels</b> — expliciete voorwaarden op tegenpartij, omschrijving, IBAN, bedrag en richting. Altijd zekerheid 100%.</li>
      <li><b>Eigen rekeningen</b> — betalingen naar een rekening die je zelf hebt geïmporteerd zijn overboekingen en tellen niet mee als uitgave.</li>
      <li><b>Geheugen</b> — eerder door jou ingedeelde tegenpartijen. Zodra je “Jumbo” één keer indeelt, volgen alle Jumbo-pinbetalingen, ongeacht winkelnummer of plaats.</li>
      <li><b>Woordenboek</b> — ruim 600 bekende Nederlandse winkels, energieleveranciers, verzekeraars, abonnementen en instanties. Generieke woorden (“cafe”, “hotel”) geven alleen een suggestie.</li>
      <li><b>Rabobank-code</b> — bijvoorbeeld geldopnames bij een geldautomaat.</li>
      <li><b>Leermodel</b> — een Naive-Bayes-classifier getraind op jouw eigen bevestigde transacties. Doet alleen suggesties (nooit automatisch).</li></ol>
    <p class="muted small">Alles draait lokaal; je gegevens verlaten je Mac nooit. Rabobank-omschrijvingen worden eerst opgeschoond (pasvolgnummers, datums, winkelnummers, plaatsnamen), zodat “ALBERT HEIJN 1234 EINDHOVEN” en “Albert Heijn 5678” dezelfde tegenpartij zijn.</p></div>`;
}

// ---------- Importeren ----------
async function importFiles(files) {
  if (!files.length) return;
  const out = [];
  for (const f of files) {
    try { const r = await POST('/import', { base64: f.base64, csv: f.text, name: f.name }); out.push({ name: f.name, r }); }
    catch (e) { out.push({ name: f.name, error: e.message }); }
  }
  await refreshMeta();
  const ok = out.filter(o => o.r), added = ok.reduce((a, o) => a + o.r.added, 0);
  if (S.tab !== 'import') go('import');
  const res = $('#importres'); if (!res) return;
  const details = r => (r.problemCount ? `<details style="margin-top:8px"><summary class="neg small">⚠ ${r.problemCount} regel${r.problemCount === 1 ? '' : 's'} overgeslagen</summary>${r.problems.map(p => `<div class="small muted">Regel ${p.row}: ${esc(p.reason)}</div>`).join('')}${r.problemCount > r.problems.length ? '<div class="small muted">…</div>' : ''}</details>` : '')
    + (r.warnings.length ? `<details style="margin-top:6px"><summary class="small muted">ℹ ${r.warnings.length} automatische reparatie${r.warnings.length === 1 ? '' : 's'} / opmerking${r.warnings.length === 1 ? '' : 'en'}</summary>${r.warnings.map(w => `<div class="small muted">${esc(w)}</div>`).join('')}</details>` : '');
  res.innerHTML = out.map(o => o.error ? `<div class="card" style="border-color:var(--bad)"><b>${esc(o.name)}</b><div class="neg">⚠ ${esc(o.error)}</div></div>` :
    `<div class="card"><b>${esc(o.name)}</b><div class="row" style="margin-top:6px;gap:16px"><span>✅ <b>${o.r.added}</b> nieuw</span><span class="muted">${o.r.skipped} dubbel overgeslagen</span>${o.r.from ? `<span class="muted">${fmtDate(o.r.from)} – ${fmtDate(o.r.to)}</span>` : ''}${o.r.newAccounts ? `<span class="tag blue">${o.r.newAccounts} nieuwe rekening</span>` : ''}</div>${details(o.r)}</div>`).join('')
    + (ok.length ? `<div class="row" style="margin-top:6px">${S.review ? `<button class="btn primary" data-go="review">${S.review} transacties beoordelen →</button>` : ''}<button class="btn" data-go="dashboard">Naar dashboard</button></div>` : '');
  res.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  if (added) { S.month = null; toast(`${added} transacties geïmporteerd`); }
}

V.import = async () => {
  const m = render(`<div class="grid g21"><div class="stack">
    <div class="dz" id="dz"><div style="font-size:34px">📥</div><b style="color:var(--text)">Sleep je Rabobank CSV hierheen</b><br>of klik om een bestand te kiezen <span class="faint">(⌘O)</span>
      <input type="file" id="file" accept=".csv,.txt,text/csv" multiple hidden></div><div id="importres" class="stack"></div></div>
    <div class="card"><h2>Exporteren uit Rabo Internetbankieren</h2><ol class="steps"><li>Log in op <b>Rabo Internetbankieren</b> en open je rekening.</li><li>Ga naar <b>Transacties</b> en kies <b>Downloaden</b>.</li><li>Kies de periode en als formaat <b>CSV</b> (kommagescheiden).</li><li>Importeer het bestand hier. Overlappende periodes zijn geen probleem: dubbele transacties worden overgeslagen.</li></ol>
      <hr><p class="muted small" style="margin:0">Tip: importeer ook je spaarrekening, dan herkent MyBudgets overboekingen tussen je eigen rekeningen automatisch.</p></div></div>`);
  const dz = $('#dz');
  dz.addEventListener('click', guard(async () => { if (window.native) importFiles(await window.native.openCSV()); else $('#file').click(); }));
  $('#file').addEventListener('change', guard(async e => importFiles(await Promise.all([...e.target.files].map(async f => ({ name: f.name, base64: await readFileBase64(f) }))))));
};

// ---------- Instellingen ----------
async function exportCSV() {
  const { csv } = await GET('/export'); const name = `MyBudgets-transacties-${new Date().toISOString().slice(0, 10)}.csv`;
  if (window.native) { if (await window.native.saveFile(name, '﻿' + csv)) toast('Geëxporteerd'); }
  else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = name; a.click(); }
}
V.settings = async () => {
  const accs = await GET('/accounts'); S.accounts = accs;
  const m = render(`<div class="grid g2">
    <div class="card"><h2>Rekeningen</h2>${accs.length ? accs.map(a => `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)" data-id="${a.id}"><div><input data-name value="${esc(a.name)}" style="width:190px"><div class="small muted" style="margin-top:3px">${esc(a.iban)} · ${a.count} transacties${a.from ? ` · ${fmtDate(a.from)} – ${fmtDate(a.to)}` : ''}</div></div><b>${a.balance != null ? eur(a.balance) : ''}</b></div>`).join('') : '<div class="empty">Nog geen rekeningen. Ze verschijnen na je eerste import.</div>'}</div>
    <div class="card"><h2>Gegevens</h2><div class="stack">
      <div class="row"><button class="btn" id="exp">Transacties exporteren (CSV)…</button></div>
      ${window.native ? `<div class="row"><button class="btn" id="bk">Back-up maken…</button><button class="btn" id="rs">Back-up herstellen…</button><button class="btn" id="rv">Toon in Finder</button></div>` : ''}
      <p class="muted small" style="margin:0">Je gegevens staan lokaal in één databasebestand. Maak regelmatig een back-up (bijv. naar iCloud Drive of Time Machine).</p><hr>
      <div class="row"><button class="btn" id="demo">Voorbeelddata laden</button><button class="btn danger" id="wipe">Alles wissen…</button></div></div></div></div>`);
  m.querySelectorAll('[data-name]').forEach(i => i.addEventListener('change', guard(async () => { await PUT('/accounts/' + i.closest('[data-id]').dataset.id, { name: i.value }); await refreshMeta(); toast('Opgeslagen'); })));
  $('#exp').onclick = guard(exportCSV);
  $('#bk')?.addEventListener('click', guard(async () => { if (await window.native.backup()) toast('Back-up gemaakt'); }));
  $('#rs')?.addEventListener('click', guard(() => window.native.restore()));
  $('#rv')?.addEventListener('click', () => window.native.reveal());
  $('#demo').onclick = guard(async () => { if (await ask('Voorbeelddata laden?', 'Er worden ~600 fictieve transacties toegevoegd aan je bestaande gegevens. Handig om de app te verkennen.', 'Laden')) { const r = await POST('/demo'); await refreshMeta(); S.month = null; toast(`${r.added} voorbeeldtransacties geladen`); } });
  $('#wipe').onclick = () => { const mm = modal(`<h3>Alles wissen?</h3><p class="muted">Alle transacties, geheugen, budgetten en rekeningen worden verwijderd. Categorieën en regels blijven bestaan. Typ <b>WISSEN</b> om te bevestigen.</p><input id="cf" placeholder="WISSEN" style="width:100%"><div class="foot"><button class="btn" data-close>Annuleren</button><button class="btn danger" id="go">Definitief wissen</button></div>`);
    mm.$('#go').onclick = guard(async () => { await POST('/reset', { confirm: mm.$('#cf').value }); mm.close(); S.month = null; await refreshMeta(); toast('Alles gewist'); go('dashboard'); }); };
};

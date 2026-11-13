'use strict';
// Shell: navigatie, maandkiezer, sneltoetsen, menu-events, slepen-en-neerzetten.
const TABS = [
  ['dashboard', 'Dashboard'], ['review', 'Te beoordelen'], ['transactions', 'Transacties'], ['budget', 'Budget'],
  ['recurring', 'Vaste lasten'], ['reports', 'Rapporten'], ['year', 'Jaaroverzicht'], ['categories', 'Categorieën & regels'],
];
const TITLES = Object.fromEntries([...TABS, ['import', 'Importeren'], ['settings', 'Instellingen'], ['detail', 'Overzicht'], ['actual', 'Importeren uit Actual Budget']]);
const NOMONTH = ['categories', 'import', 'settings', 'recurring', 'review', 'actual', 'year'];

function updateNav() {
  $('#nav').innerHTML = TABS.map(([k, l]) => `<button class="nav-item ${S.tab === k ? 'active' : ''}" ${S.tab === k ? 'aria-current="page"' : ''} data-tab="${k}">${icon(k)}<span>${l}</span>${k === 'review' && S.review ? `<span class="badge">${S.review}</span>` : ''}</button>`).join('')
    + `<div class="nav-sep"></div>` + [['import', 'Importeren'], ['settings', 'Instellingen']].map(([k, l]) => `<button class="nav-item ${S.tab === k ? 'active' : ''}" data-tab="${k}">${icon(k)}<span>${l}</span></button>`).join('');
  // Telefoon: vier hoofdschermen + Meer (de rest staat in een sheet)
  const inMore = !PRIMARY.includes(S.tab);
  $('#tabbar').innerHTML = PRIMARY.map(k => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}" ${S.tab === k ? 'aria-current="page"' : ''}>${icon(k)}<span>${SHORT[k] || TITLES[k]}</span>${k === 'review' && S.review ? `<span class="badge">${S.review > 999 ? '999+' : S.review}</span>` : ''}</button>`).join('')
    + `<button data-more class="${inMore ? 'on' : ''}" aria-haspopup="dialog">${icon('more')}<span>Meer</span></button>`;
  const bal = S.accounts.filter(a => a.balance != null).reduce((a, b) => a + b.balance, 0);
  $('#sidefoot').innerHTML = (S.accounts.some(a => a.balance != null) ? `Totaalsaldo<b>${eur(bal)}</b>` : '<span class="faint">Lokaal &amp; privé</span>')
    + (S.version ? `<div class="faint" style="margin-top:6px;font-size:11px">MyBudgets ${esc(S.version)}</div>` : '');
}
const PRIMARY = ['dashboard', 'review', 'transactions', 'budget'];
const SHORT = { review: 'Beoordelen', categories: 'Categorieën' };
function monthLabel(m) { $('#monthlabel').innerHTML = m ? `<span class="ml-l">${monthName(m)}</span><span class="ml-s">${monthShort(m)} ${m.slice(0, 4)}</span>` : ''; }
function setMonth(m, months) {
  S.month = m; if (months) S.months = months;
  monthLabel(m);
}
function openMore() {
  const items = [...TABS.filter(([k]) => !PRIMARY.includes(k)), ['import', 'Importeren'], ['settings', 'Instellingen']];
  const bal = S.accounts.filter(a => a.balance != null).reduce((a, b) => a + b.balance, 0);
  const m = modal(`<div class="more-grid">${items.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${icon(k)}<span>${SHORT[k] || l}</span></button>`).join('')}
      <button data-search>${icon('search')}<span>Zoeken</span></button></div>
    ${S.accounts.some(a => a.balance != null) ? `<div class="more-bal"><span class="muted">Totaalsaldo</span><b>${eur(bal)}</b></div>` : ''}
    ${S.version ? `<div class="faint small" style="text-align:center;margin-top:10px">MyBudgets ${esc(S.version)}</div>` : ''}`);
  m.el.addEventListener('click', e => {
    const b = e.target.closest('[data-tab],[data-search]'); if (!b) return;
    m.close(); if (b.dataset.search !== undefined) openPalette(); else { S.txFilter = {}; go(b.dataset.tab); }
  });
}
async function refreshMeta() {
  if (!S.version) S.version = (await GET('/version').catch(() => ({}))).version;
  S.cats = await GET('/categories');
  const [accs, rev] = await Promise.all([GET('/accounts'), GET('/review')]);
  S.accounts = accs; S.review = rev.reduce((a, g) => a + g.count, 0); S.hasData = accs.some(a => a.count > 0);
  updateNav();
}
async function go(tab) {
  clearKeyHandler();
  if (tab === 'detail' && S.tab !== 'detail') S.backTab = S.tab;
  S.tab = tab;
  if (tab !== 'detail') pref.set('tab', tab);
  NAV++;
  if (S.month) { pref.set('month', S.month); monthLabel(S.month); } document.title = 'MyBudgets';
  $('#title').textContent = TITLES[tab];
  $('#monthpick').style.display = NOMONTH.includes(tab) ? 'none' : '';
  updateNav();
  $('#main').scrollTop = 0;
  try { await V[tab](); }
  catch (e) {
    if (e?.stale) return;
    console.error(e);
    // Scherm kon niet laden (bijv. server even weg): duidelijke melding met opnieuw proberen i.p.v. een half scherm
    render(`<div class="hero"><div class="big">⚠️</div><h2>Dit scherm kon niet worden geladen</h2><p>${esc(e.message || 'Er ging iets mis')}</p><button class="btn primary" id="retry">Opnieuw proberen</button></div>`);
    $('#retry').onclick = () => go(tab);
  }
  updateNav();
}
function stepMonth(delta) {
  if (!S.month) return;
  S.month = shiftMonth(S.month, delta); go(S.tab); // ook buiten de data toegestaan, handig om budget vooruit te plannen
}

$('#nav').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { S.txFilter = {}; go(b.dataset.tab); } });
$('#tabbar').addEventListener('click', e => {
  if (e.target.closest('[data-more]')) return openMore();
  const b = e.target.closest('[data-tab]'); if (!b) return;
  if (b.dataset.tab === S.tab) { $('#main').scrollTo({ top: 0, behavior: 'smooth' }); return; }   // nogmaals tikken = naar boven
  S.txFilter = {}; go(b.dataset.tab);
});
// Breedte verandert (uit-/dichtvouwen, draaien, venster): huidig scherm opnieuw tekenen zodat grafieken en indeling passen.
// Alleen bij een echte breedteverandering, en niet terwijl je iets aan het invullen bent.
let lastW = $('#main').clientWidth;
new ResizeObserver(debounce(() => {
  const w = $('#main').clientWidth; if (Math.abs(w - lastW) < 24) return; lastW = w;
  if (document.querySelector('.overlay') || document.activeElement?.matches('input,textarea,select')) return;
  const top = $('#main').scrollTop; NAV++; guard(async () => { await V[S.tab](); $('#main').scrollTop = top; })();
}, 220)).observe($('#main'));
$('#prev').onclick = () => stepMonth(-1);
$('#next').onclick = () => stepMonth(1);
$('#monthlabel').onclick = () => { S.month = S.months[0] || S.month; go(S.tab); };
$('#importbtn').onclick = () => go('import');
$('#palettebtn').onclick = () => openPalette();

// Sneltoetsen (in Electron komen ze via het menu; dit is de browser-fallback)
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openPalette(); } });
if (!window.native) document.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey) || e.target.matches('input,textarea,select')) return;
  const n = Number(e.key); if (n >= 1 && n <= 8) { e.preventDefault(); S.txFilter = {}; go(TABS[n - 1][0]); }
  if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
  if (e.key === '[') stepMonth(-1); if (e.key === ']') stepMonth(1);
});
if (window.native) {
  document.body.classList.add(window.native.platform === 'darwin' ? 'mac' : 'other');
  window.native.onMenu(guard(async m => {
    if (m.action === 'nav') { S.txFilter = {}; go(m.tab); }
    else if (m.action === 'month') stepMonth(m.delta);
    else if (m.action === 'import-dialog') importFiles(await window.native.openCSV());
    else if (m.action === 'import-files') importFiles(m.files);
    else if (m.action === 'export') exportCSV();
    else if (m.action === 'pdf') { if (await window.native.exportPDF(`MyBudgets-${S.tab}-${S.month || ''}.pdf`)) toast('PDF opgeslagen'); }
    else if (m.action === 'backup') { if (await window.native.backup()) toast('Back-up gemaakt'); }
    else if (m.action === 'restore') window.native.restore();
    else if (m.action === 'undo') { if (document.activeElement?.matches('input,textarea')) document.execCommand('undo'); else doUndo(); }
    else if (m.action === 'palette') openPalette();
    else if (m.action === 'actual') go('actual');
    else if (m.action === 'search') { S.txFilter = { focusSearch: true }; go('transactions'); }
  }));
}
// Bestanden overal in het venster neerzetten = importeren
let dragDepth = 0;
const overlay = () => { let o = $('#dropov'); if (!o) { o = document.createElement('div'); o.id = 'dropov'; o.className = 'overlay'; o.style.pointerEvents = 'none'; o.innerHTML = '<div class="modal" style="text-align:center;padding:40px"><div style="font-size:40px">📥</div><h3>Laat los om te importeren</h3></div>'; document.body.appendChild(o); } return o; };
window.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; overlay(); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropov')?.remove(); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', guard(async e => {
  e.preventDefault(); dragDepth = 0; $('#dropov')?.remove();
  const all = [...(e.dataTransfer?.files || [])];
  // ZIP of db.sqlite = Actual Budget-export; anders Rabobank-CSV
  const nf = all.find(f => /\.(zip|sqlite)$/i.test(f.name));
  if (nf) return loadActualFile({ name: nf.name, base64: await readFileBase64(nf) });
  const files = all.filter(f => /\.(csv|txt)$/i.test(f.name));
  if (!files.length) return toast('Sleep een .csv-bestand uit Rabo Internetbankieren of een .zip-export uit Actual Budget');
  importFiles(await Promise.all(files.map(async f => ({ name: f.name, base64: await readFileBase64(f) }))));
}));

// Terug naar de app na een tijdje weg (telefoon uit zak, ander tabblad): gegevens verversen, zodat je ziet wat de
// ander intussen heeft gedaan. Niet als je midden in iets zit.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (!hiddenAt || Date.now() - hiddenAt < 60000 || window.native) return;
  if (document.querySelector('.overlay') || document.activeElement?.matches('input,textarea,select')) return;
  const top = $('#main').scrollTop;
  guard(async () => { await refreshMeta(); NAV++; await V[S.tab](); $('#main').scrollTop = top; })();
});
const isMacLike = window.native ? window.native.platform === 'darwin' : /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
if (!isMacLike) $('#palettebtn kbd').textContent = 'Ctrl K';
guard(async () => {
  applyTheme(pref.get('theme'));
  await refreshMeta();
  const savedMonth = pref.get('month'), savedTab = pref.get('tab');
  if (savedMonth && /^\d{4}-\d{2}$/.test(savedMonth)) S.month = savedMonth;
  const valid = TABS.some(t => t[0] === savedTab) || savedTab === 'settings';
  await go(S.hasData && valid ? savedTab : 'dashboard');
})();

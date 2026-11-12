'use strict';
// Shell: navigatie, maandkiezer, sneltoetsen, menu-events, slepen-en-neerzetten.
const TABS = [
  ['dashboard', 'Dashboard'], ['review', 'Te beoordelen'], ['transactions', 'Transacties'], ['budget', 'Budget'],
  ['recurring', 'Vaste lasten'], ['reports', 'Rapporten'], ['categories', 'Categorieën & regels'],
];
const TITLES = Object.fromEntries([...TABS, ['import', 'Importeren'], ['settings', 'Instellingen'], ['detail', 'Overzicht']]);
const NOMONTH = ['categories', 'import', 'settings', 'recurring', 'review'];

function updateNav() {
  $('#nav').innerHTML = TABS.map(([k, l]) => `<button class="nav-item ${S.tab === k ? 'active' : ''}" data-tab="${k}">${icon(k)}<span>${l}</span>${k === 'review' && S.review ? `<span class="badge">${S.review}</span>` : ''}</button>`).join('')
    + `<div class="nav-sep"></div>` + [['import', 'Importeren'], ['settings', 'Instellingen']].map(([k, l]) => `<button class="nav-item ${S.tab === k ? 'active' : ''}" data-tab="${k}">${icon(k)}<span>${l}</span></button>`).join('');
  const bal = S.accounts.filter(a => a.balance != null).reduce((a, b) => a + b.balance, 0);
  $('#sidefoot').innerHTML = S.accounts.some(a => a.balance != null) ? `Totaalsaldo<b>${eur(bal)}</b>` : '<span class="faint">Lokaal &amp; privé</span>';
}
function setMonth(m, months) {
  S.month = m; if (months) S.months = months;
  $('#monthlabel').textContent = monthName(m);
}
async function refreshMeta() {
  S.cats = await GET('/categories');
  const [accs, rev] = await Promise.all([GET('/accounts'), GET('/review')]);
  S.accounts = accs; S.review = rev.reduce((a, g) => a + g.count, 0); S.hasData = accs.some(a => a.count > 0);
  updateNav();
}
async function go(tab) {
  if (tab === 'detail' && S.tab !== 'detail') S.backTab = S.tab;
  S.tab = tab; document.title = 'MyBudgets';
  $('#title').textContent = TITLES[tab];
  $('#monthpick').style.display = NOMONTH.includes(tab) ? 'none' : '';
  updateNav();
  $('#main').scrollTop = 0;
  await guard(() => V[tab]())();
  updateNav();
}
function stepMonth(delta) {
  if (!S.month) return;
  S.month = shiftMonth(S.month, delta); go(S.tab); // ook buiten de data toegestaan, handig om budget vooruit te plannen
}

$('#nav').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { S.txFilter = {}; go(b.dataset.tab); } });
$('#prev').onclick = () => stepMonth(-1);
$('#next').onclick = () => stepMonth(1);
$('#monthlabel').onclick = () => { S.month = S.months[0] || S.month; go(S.tab); };
$('#importbtn').onclick = () => go('import');
$('#palettebtn').onclick = () => openPalette();

// Sneltoetsen (in Electron komen ze via het menu; dit is de browser-fallback)
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openPalette(); } });
if (!window.native) document.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey) || e.target.matches('input,textarea,select')) return;
  const n = Number(e.key); if (n >= 1 && n <= 7) { e.preventDefault(); S.txFilter = {}; go(TABS[n - 1][0]); }
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
    else if (m.action === 'backup') { if (await window.native.backup()) toast('Back-up gemaakt'); }
    else if (m.action === 'restore') window.native.restore();
    else if (m.action === 'undo') { if (document.activeElement?.matches('input,textarea')) document.execCommand('undo'); else doUndo(); }
    else if (m.action === 'palette') openPalette();
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
  const files = [...(e.dataTransfer?.files || [])].filter(f => /\.(csv|txt)$/i.test(f.name));
  if (!files.length) return toast('Sleep een .csv-bestand uit Rabo Internetbankieren');
  importFiles(await Promise.all(files.map(async f => ({ name: f.name, base64: await readFileBase64(f) }))));
}));

guard(async () => { await refreshMeta(); await go('dashboard'); })();

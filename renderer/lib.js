// Gedeelde helpers. Bedragen zijn altijd gehele centen.
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Negatieve bedragen als "−€ 12,34" (echt minteken vóór het euroteken) in plaats van "€ -12,34"
const fmtEur = (c, opts) => (c / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR', ...opts });
const eur = c => (c < 0 ? '−' + fmtEur(-c) : fmtEur(c));
const num0 = c => (Math.abs(c) < 50 ? 0 : Math.round(c / 100)).toLocaleString('nl-NL');
const eur0 = c => (Math.abs(c) < 50 ? fmtEur(0, { maximumFractionDigits: 0 }) : c < 0 ? '−' + fmtEur(-c, { maximumFractionDigits: 0 }) : fmtEur(c, { maximumFractionDigits: 0 }));
const eurSigned = c => (c > 0 ? '+' : '') + eur(c);
const monthName = m => new Date(m + '-01T12:00').toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' });
const monthShort = m => new Date(m + '-01T12:00').toLocaleDateString('nl-NL', { month: 'short' }).replace('.', '');
const fmtDate = d => new Date(d + 'T12:00').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\./g, '');
const fmtDay = d => new Date(d + 'T12:00').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }).replace(/\./g, '');
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);

// Kleine, veilige opslag voor voorkeuren (kan falen in privé-modus)
const pref = { get(k) { try { return localStorage.getItem('mb.' + k); } catch { return null; } }, set(k, v) { try { localStorage.setItem('mb.' + k, v); } catch { /* geen opslag beschikbaar */ } } };
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  if (window.native && window.native.setTheme) window.native.setTheme(t === 'light' || t === 'dark' ? t : 'system');
}
const S = { tab: 'dashboard', month: null, cats: [], months: [], accounts: [], review: 0, txFilter: {}, hasData: false };
const catById = id => S.cats.find(c => c.id === id);

// Navigatieteller: antwoorden op GET-verzoeken van een scherm dat al verlaten is worden genegeerd (geen flikkering
// of verkeerd scherm als je snel tikt). guard() slikt die stille fout in.
let NAV = 0;
const staleErr = () => Object.assign(new Error('verouderd'), { stale: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function httpApi(method, path, body) {
  const ctl = new AbortController(), big = body && body.base64;
  const timer = setTimeout(() => ctl.abort(), big ? 180000 : 30000);
  let r;
  try {
    r = await fetch('/api' + path, { method, signal: ctl.signal, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body || {}) });
  } catch (e) {
    throw Object.assign(new Error(e.name === 'AbortError' ? 'De server reageert niet (time-out)' : navigator.onLine === false ? 'Geen internetverbinding' : 'Geen verbinding met de server'), { network: true });
  } finally { clearTimeout(timer); }
  const text = await r.text(); let j = null;
  try { j = text ? JSON.parse(text) : {}; } catch { /* geen JSON, bijv. een proxy-foutpagina */ }
  if (r.status === 401) throw new Error('Niet (meer) ingelogd — herlaad de pagina');
  if (!r.ok) throw Object.assign(new Error(j?.error || (r.status >= 502 ? 'De server is even niet bereikbaar' : `Fout ${r.status}`)), { status: r.status, network: r.status >= 502 });
  if (j === null) throw new Error('Onverwacht antwoord van de server');
  return j;
}
async function api(method, path, body) {
  const seq = NAV;
  let res;
  if (window.native) res = await window.native.api(method, '/api' + path, body);
  else {
    try { res = await httpApi(method, path, body); }
    catch (e) { if (method !== 'GET' || !e.network) throw e; await sleep(900); res = await httpApi(method, path, body); }   // lezen: één keer opnieuw (bijv. server herstart)
  }
  if (method === 'GET' && seq !== NAV) throw staleErr();
  return res;
}
const GET = p => api('GET', p), POST = (p, b) => api('POST', p, b), PUT = (p, b) => api('PUT', p, b), PATCH = (p, b) => api('PATCH', p, b), DEL = p => api('DELETE', p);

let toastT, lastUndo = null;
function toast(msg, undoId) {
  const t = $('#toast'); t.textContent = msg;
  if (undoId) {
    lastUndo = undoId;
    const b = document.createElement('button'); b.textContent = 'Ongedaan maken'; b.className = 'toast-btn'; b.onclick = () => doUndo();
    t.append(b);
  }
  t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), undoId ? 7000 : 3200);
}
async function doUndo() {
  if (!lastUndo) return toast('Niets om ongedaan te maken');
  const id = lastUndo; lastUndo = null;
  try { await POST('/undo', { id }); await refreshMeta(); toast('Ongedaan gemaakt'); go(S.tab); } catch (e) { toast('⚠ ' + e.message); }
}
const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { if (e?.stale) return; console.error(e); toast('⚠ ' + (e.message || 'Er ging iets mis')); } };

function catChip(c, extra = '') {
  if (!c) return `<span class="chip" style="--c:#9ca3af">❔ Geen categorie</span>`;
  return `<span class="chip" style="--c:${c.color}">${c.icon || ''} ${esc(c.name)}${extra}</span>`;
}
// <select> met categorieën per groep. opts: {none:'— kies —', value}
function catSelect(value, { none = '— geen —', cls = 'cat-input', attrs = '', kinds } = {}) {
  const kindNl = { income: 'Inkomen', expense: 'Uitgaven', transfer: 'Overboekingen' };
  let h = `<select class="${cls}" ${attrs}>` + (none !== null ? `<option value="">${none}</option>` : '');
  for (const k of ['income', 'expense', 'transfer']) {
    if (kinds && !kinds.includes(k)) continue;
    const list = S.cats.filter(c => c.kind === k); if (!list.length) continue;
    const groups = [...new Set(list.map(c => c.grp))];
    for (const g of groups) h += `<optgroup label="${kindNl[k]}${k === 'expense' ? ' · ' + esc(g) : ''}">` +
      list.filter(c => c.grp === g).map(c => `<option value="${c.id}" ${c.id === value ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('') + '</optgroup>';
  }
  return h + '</select>';
}

function modal(html, { wide } = {}) {
  const root = $('#modal-root');
  const el = document.createElement('div'); el.className = 'overlay';
  el.innerHTML = `<div class="modal" tabindex="-1" ${wide ? 'style="width:min(760px,94vw)"' : ''} role="dialog" aria-modal="true">${html}</div>`;
  const opener = document.activeElement; // na sluiten keert de focus daarheen terug
  const close = () => { el.remove(); document.removeEventListener('keydown', onKey); if (opener && opener.isConnected && opener.focus) opener.focus(); };
  const onKey = e => {
    if (e.key === 'Escape') return close();
    if (e.key !== 'Tab') return;
    // Tab blijft binnen het dialoog
    const f = [...el.querySelectorAll('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])')].filter(n => !n.disabled && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey);
  el.addEventListener('mousedown', e => { if (e.target === el) close(); });
  root.appendChild(el); fillCharts(el);
  $$('[data-close]', el).forEach(b => b.addEventListener('click', close));
  // Op touchscreens niet automatisch een veld focussen: dat klapt ongevraagd het toetsenbord uit.
  const first = $('input:not([type=checkbox]),select,textarea', el); if (first && !matchMedia('(pointer:coarse)').matches) first.focus(); else el.querySelector('.modal').focus?.();
  return { el, close, $: s => $(s, el), $$: s => $$(s, el) };
}
function ask(title, message, okLabel = 'OK', danger = false) {
  return new Promise(res => {
    const m = modal(`<h3>${esc(title)}</h3><p class="muted" style="margin:0">${message}</p><div class="foot"><button class="btn" data-close>Annuleren</button><button class="btn ${danger ? 'danger' : 'primary'}" id="ok">${esc(okLabel)}</button></div>`);
    m.$('#ok').addEventListener('click', () => { m.close(); res(true); });
    m.el.addEventListener('mousedown', e => { if (e.target === m.el) res(false); });
    $$('[data-close]', m.el).forEach(b => b.addEventListener('click', () => res(false)));
  });
}
// Grafieken worden op hun echte breedte getekend (leesbare labels op telefoon én breed scherm).
// chartBox() geeft een plaatshouder; render()/fillCharts() tekent hem zodra de breedte bekend is.
const CHARTS = new Map(); let chartSeq = 0;
function chartBox(draw) { const id = ++chartSeq; CHARTS.set(id, draw); return `<div class="chart" data-chart="${id}"></div>`; }
function fillCharts(root = document) {
  root.querySelectorAll('.chart[data-chart]').forEach(el => {
    const id = +el.dataset.chart, draw = CHARTS.get(id); if (!draw) return;
    el.innerHTML = draw(Math.max(260, Math.round(el.clientWidth || 600))); delete el.dataset.chart; CHARTS.delete(id);
  });
  if (CHARTS.size > 50) CHARTS.clear();
}
function render(html) { const m = $('#main'); m.innerHTML = `<div class="page">${html}</div>`; fillCharts(m); return m; }

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  review: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  transactions: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  year: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  budget: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  recurring: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  reports: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  categories: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  import: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  insights: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2.2h5c.1-1 .5-1.7 1.1-2.2A6 6 0 0 0 12 3z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  detail: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
};
const icon = n => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

// Bestand -> base64 van de ruwe bytes; de parser herkent zelf de codering (UTF-8 / ISO-8859-1).
const readFileBase64 = file => new Promise((res, rej) => {
  const r = new FileReader(); r.onerror = () => rej(new Error('Bestand kon niet worden gelezen'));
  r.onload = () => res(String(r.result).split(',')[1] || ''); r.readAsDataURL(file);
});
function deltaChip(cur, prev, higherIsBad) {
  if (!prev || !cur) return '';
  const d = cur - prev, p = Math.round(Math.abs(d) / prev * 100);
  if (p < 1) return `<span class="delta flat">≈ vorige maand</span>`;
  const bad = higherIsBad ? d > 0 : d < 0;
  return `<span class="delta ${d > 0 ? 'up' : 'down'}-${bad ? 'bad' : 'good'}">${d > 0 ? '▲' : '▼'} ${p}%</span>`;
}

// Eén actieve toetsenbordhandler per scherm; go() ruimt hem op bij het wisselen van scherm.
let activeKeyHandler = null;
function setKeyHandler(fn) { clearKeyHandler(); activeKeyHandler = fn; document.addEventListener("keydown", fn); }
function clearKeyHandler() { if (activeKeyHandler) document.removeEventListener("keydown", activeKeyHandler); activeKeyHandler = null; }

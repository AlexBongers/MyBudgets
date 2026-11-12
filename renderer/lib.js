// Gedeelde helpers. Bedragen zijn altijd gehele centen.
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = c => (c / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
const num0 = c => (Math.abs(c) < 50 ? 0 : Math.round(c / 100)).toLocaleString('nl-NL');
const eur0 = c => (Math.abs(c) < 50 ? 0 : c / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eurSigned = c => (c > 0 ? '+' : '') + eur(c);
const monthName = m => new Date(m + '-01T12:00').toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' });
const monthShort = m => new Date(m + '-01T12:00').toLocaleDateString('nl-NL', { month: 'short' }).replace('.', '');
const fmtDate = d => new Date(d + 'T12:00').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\./g, '');
const fmtDay = d => new Date(d + 'T12:00').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }).replace(/\./g, '');
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);

const S = { tab: 'dashboard', month: null, cats: [], months: [], accounts: [], review: 0, txFilter: {}, hasData: false };
const catById = id => S.cats.find(c => c.id === id);

async function api(method, path, body) {
  if (window.native) return window.native.api(method, '/api' + path, body);
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body || {}) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Fout'); return j;
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
const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { console.error(e); toast('⚠ ' + (e.message || 'Er ging iets mis')); } };

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
  el.innerHTML = `<div class="modal" ${wide ? 'style="width:min(760px,94vw)"' : ''} role="dialog">${html}</div>`;
  const close = () => { el.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('mousedown', e => { if (e.target === el) close(); });
  root.appendChild(el);
  $$('[data-close]', el).forEach(b => b.addEventListener('click', close));
  const first = $('input:not([type=checkbox]),select,textarea', el); if (first) first.focus();
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
function render(html) { const m = $('#main'); m.innerHTML = `<div class="page">${html}</div>`; return m; }

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  review: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  transactions: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  budget: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  recurring: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  reports: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  categories: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  import: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
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

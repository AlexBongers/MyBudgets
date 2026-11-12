'use strict';
// Opdrachtpalet (⌘K): snel naar schermen, categorieën, tegenpartijen, transacties en acties.
let paletteOpen = false;
function openPalette() {
  if (paletteOpen) return;
  paletteOpen = true;
  const base = [
    ...TABS.map(([k, l], i) => ({ g: 'Ga naar', icon: '→', label: l, hint: `⌘${i + 1}`, run: () => { S.txFilter = {}; go(k); } })),
    { g: 'Ga naar', icon: '→', label: 'Importeren', run: () => go('import') },
    { g: 'Ga naar', icon: '→', label: 'Instellingen', run: () => go('settings') },
    { g: 'Acties', icon: '📥', label: 'Rabobank CSV importeren…', hint: '⌘O', run: guard(async () => { if (window.native) importFiles(await window.native.openCSV()); else go('import'); }) },
    { g: 'Acties', icon: '⬇️', label: 'Transacties exporteren (CSV)', hint: '⇧⌘E', run: guard(exportCSV) },
    ...(window.native ? [{ g: 'Acties', icon: '📄', label: 'Dit scherm exporteren als PDF', hint: '⌘P', run: guard(async () => { if (await window.native.exportPDF(`MyBudgets-${S.tab}-${S.month || ''}.pdf`)) toast('PDF opgeslagen'); }) }] : []),
    { g: 'Acties', icon: '↻', label: 'Alles opnieuw categoriseren', run: guard(async () => { const r = await POST('/recategorize'); await refreshMeta(); toast(`${r.changed} transactie(s) opnieuw ingedeeld`); }) },
    { g: 'Acties', icon: '🆕', label: 'Nieuwe regel…', run: () => ruleModal() },
    ...S.cats.map(c => ({ g: 'Categorieën', icon: c.icon, label: c.name, hint: c.grp, run: () => openCategory(c.id) })),
  ];
  const m = modal(`<input id="pq" placeholder="Zoek een scherm, categorie, tegenpartij of transactie…" style="width:100%;font-size:15px;padding:9px 12px"><div id="pres" style="margin-top:10px;max-height:52vh;overflow:auto"></div>`);
  m.el.firstElementChild.style.cssText = 'width:min(640px,92vw);padding:14px;margin-top:14vh';
  m.el.style.alignItems = 'start';
  const input = m.$('#pq'), res = m.$('#pres');
  let items = [], sel = 0, remote = { merchants: [], transactions: [] };
  const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const compute = () => {
    const t = fold(input.value.trim());
    let list = t ? base.filter(b => fold(b.label).includes(t) || fold(b.hint || '').includes(t)) : base.filter(b => b.g !== 'Categorieën');
    list = list.slice(0, 14);
    if (t) {
      list.push(...remote.merchants.map(x => ({ g: 'Tegenpartijen', icon: '🏪', label: x.name, hint: `${x.n}× · ${eur0(Math.abs(x.total))}`, run: () => openMerchant(x.merchant) })));
      list.push(...remote.transactions.map(x => ({ g: 'Transacties', icon: '🧾', label: x.payee, hint: `${fmtDay(x.date)} · ${eur(x.amount)}`, run: () => txDetail(x.id) })));
    }
    items = list; sel = Math.min(sel, Math.max(0, items.length - 1));
    let g = '';
    res.innerHTML = items.length ? items.map((it, i) => {
      const head = it.g !== g ? `<div class="nav-label" style="padding:8px 8px 3px">${it.g}</div>` : '';
      g = it.g;
      return `${head}<div class="nav-item ${i === sel ? 'active' : ''}" data-i="${i}" style="padding:6px 10px"><span style="width:22px;text-align:center">${it.icon}</span><span>${esc(it.label)}</span><span class="small" style="margin-left:auto;opacity:.65">${esc(it.hint || '')}</span></div>`;
    }).join('') : '<div class="empty">Geen resultaten</div>';
    res.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const run = i => { const it = items[i]; if (!it) return; m.close(); paletteOpen = false; setTimeout(it.run, 30); };
  const fetchRemote = debounce(async () => {
    const t = input.value.trim();
    try { remote = t.length < 2 ? { merchants: [], transactions: [] } : await GET('/search?q=' + encodeURIComponent(t)); } catch { remote = { merchants: [], transactions: [] }; }
    compute();
  }, 180);
  input.addEventListener('input', () => { sel = 0; compute(); fetchRemote(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); e.preventDefault(); compute(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); e.preventDefault(); compute(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  });
  res.addEventListener('click', e => { const el = e.target.closest('[data-i]'); if (el) run(+el.dataset.i); });
  new MutationObserver(() => { if (!document.contains(m.el)) paletteOpen = false; }).observe($('#modal-root'), { childList: true });
  compute();
  input.focus();
}

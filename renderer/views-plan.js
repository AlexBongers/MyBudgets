'use strict';
// ---------- Budget ----------
V.budget = async () => {
  const [rows, dash] = await Promise.all([GET('/budget?month=' + S.month), GET('/dashboard?month=' + S.month)]);
  const tb = rows.reduce((a, b) => a + b.budget, 0), ts = rows.reduce((a, b) => a + (b.budget ? b.spent : 0), 0);
  const unbudgetedSpent = rows.filter(r => !r.budget).reduce((a, b) => a + b.spent, 0);
  const free = dash.totals.income - tb;
  const groups = [...new Set(rows.map(r => r.grp))];
  const m = render(`
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card kpi"><h2>Totaal budget</h2><div class="v">${eur(tb)}</div><div class="sub">per maand</div></div>
      <div class="card kpi"><h2>Besteed (met budget)</h2><div class="v">${eur(ts)}</div><div class="sub">${tb ? pct(ts, tb) + '% van budget' : '–'}</div></div>
      <div class="card kpi"><h2>Resterend</h2><div class="v ${tb - ts < 0 ? 'neg' : 'pos'}">${eur(tb - ts)}</div><div class="sub">${unbudgetedSpent > 0 ? `+ ${eur0(unbudgetedSpent)} zonder budget` : 'alles gebudgetteerd'}</div></div>
      <div class="card kpi"><h2>Nog te verdelen</h2><div class="v ${free < 0 ? 'neg' : ''}">${dash.totals.income ? eur(free) : '–'}</div><div class="sub">inkomen minus budget</div></div>
    </div>
    <div class="row" style="margin-bottom:12px"><button class="btn" id="fill" title="Vul lege categorieën met het gemiddelde van de laatste 3 maanden">✨ Vul aan met gemiddelde</button><button class="btn" id="copy">Kopieer vorige maand</button>
      <span class="muted small">Een budget geldt vanaf de gekozen maand tot je het wijzigt.</span></div>
    <div class="card" style="padding:0"><div class="tablewrap"><table><thead><tr><th>Categorie</th><th style="width:24%">Voortgang</th><th class="num">Budget (€)</th><th class="num">Gem. 3 mnd</th><th class="num">Besteed</th><th class="num">Resterend</th></tr></thead><tbody>
      ${groups.map(g => { const list = rows.filter(r => r.grp === g); return `<tr class="grp"><td colspan="6" style="background:var(--hover);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)">${esc(g)} <span style="float:right">${eur0(list.reduce((a, b) => a + b.spent, 0))} / ${eur0(list.reduce((a, b) => a + b.budget, 0))}</span></td></tr>` +
        list.map(r => { const left = r.budget - r.spent; return `<tr><td><i class="dot" style="background:${r.color}"></i> ${r.icon} ${esc(r.name)}</td><td>${progressBar(r.spent, r.budget)}</td>
        <td class="num"><input type="number" min="0" step="5" value="${r.budget ? r.budget / 100 : ''}" placeholder="0" data-cat="${r.id}" style="width:84px;text-align:right"></td>
        <td class="num">${r.avg3 ? `<a href="#" class="muted" data-avg="${r.id}:${Math.round(r.avg3 / 500) * 5}" title="Gebruik gemiddelde als budget">${eur0(r.avg3)}</a>` : '<span class="faint">–</span>'}</td>
        <td class="num">${r.spent ? eur(r.spent) : '<span class="faint">–</span>'}</td><td class="num ${r.budget ? (left < 0 ? 'neg' : 'pos') : 'faint'}">${r.budget ? eur(left) : '–'}</td></tr>`; }).join(''); }).join('')}
    </tbody></table></div></div>`);
  const save = guard(async (cat, euros) => { const top = $('#main').scrollTop; await PUT('/budget', { category_id: cat, month: S.month, amount: Math.round(Number(euros) * 100) }); await V.budget(); $('#main').scrollTop = top; });
  m.querySelectorAll('input[data-cat]').forEach(i => i.addEventListener('change', () => save(+i.dataset.cat, i.value || 0)));
  m.querySelectorAll('[data-avg]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); const [c, v] = a.dataset.avg.split(':'); save(+c, v); }));
  $('#fill').onclick = guard(async () => { const r = await POST('/budget/fill', { month: S.month }); toast(r.filled ? `${r.filled} budgetten ingevuld` : 'Niets om aan te vullen'); V.budget(); });
  $('#copy').onclick = guard(async () => { const r = await POST('/budget/copy', { from: shiftMonth(S.month, -1), to: S.month }); toast(`${r.copied} budgetten gekopieerd`); V.budget(); });
};

// ---------- Vaste lasten ----------
V.recurring = async () => {
  const list = await GET('/recurring');
  const act = list.filter(r => r.active), old = list.filter(r => !r.active);
  const monthly = act.reduce((a, r) => a + r.monthly, 0), today = new Date().toISOString().slice(0, 10);
  const rel = d => { const n = Math.round((new Date(d) - new Date(today)) / 864e5); return n === 0 ? 'vandaag' : n > 0 ? `over ${n} dag${n === 1 ? '' : 'en'}` : `${-n} dagen geleden`; };
  const tbl = (rows, dim) => `<table><thead><tr><th>Naam</th><th>Categorie</th><th>Frequentie</th><th class="num">Bedrag</th><th class="num">Per maand</th><th>Laatste</th><th>Volgende</th></tr></thead><tbody>
    ${rows.map(r => `<tr data-m="${esc(r.merchant)}" style="${dim ? 'opacity:.6' : ''}"><td class="tx-name">${esc(r.name)}</td><td>${catChip(catById(r.category_id))}</td><td>${r.frequency}${r.variable ? ' <span class="tag" title="Bedrag wisselt">variabel</span>' : ''}</td>
    <td class="num">${r.variable ? '~' : ''}${eur(r.amount)}</td><td class="num">${eur0(r.monthly)}</td><td class="muted small">${fmtDay(r.last)}</td><td class="small">${dim ? '–' : `${fmtDay(r.next)} <span class="muted">· ${rel(r.next)}</span>`}</td></tr>`).join('')}</tbody></table>`;
  const m = render(list.length ? `
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card kpi"><h2>Vaste lasten</h2><div class="v">${eur0(monthly)}</div><div class="sub">per maand · ${act.length} posten</div></div>
      <div class="card kpi"><h2>Per jaar</h2><div class="v">${eur0(monthly * 12)}</div><div class="sub">alle actieve posten</div></div>
      <div class="card kpi"><h2>Grootste</h2><div class="v" style="font-size:20px">${esc(act[0]?.name || '–')}</div><div class="sub">${act[0] ? eur0(act[0].monthly) + ' per maand' : ''}</div></div>
      <div class="card kpi"><h2>Abonnementen</h2><div class="v">${eur0(act.filter(r => catById(r.category_id)?.key === 'subscriptions').reduce((a, r) => a + r.monthly, 0))}</div><div class="sub">streaming, software e.d.</div></div></div>
    <div class="card" style="padding:0;margin-bottom:16px"><div class="tablewrap">${tbl(act)}</div></div>
    ${old.length ? `<h3 class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.05em">Niet meer actief</h3><div class="card" style="padding:0"><div class="tablewrap">${tbl(old, true)}</div></div>` : ''}
    <p class="muted small">Terugkerende betalingen worden automatisch herkend op basis van regelmaat in datum en bedrag. Supermarkten, horeca en tanken tellen niet mee.</p>`
    : `<div class="empty">Nog geen terugkerende betalingen herkend. Importeer minimaal 3 maanden aan transacties.</div>`);
  m.querySelectorAll('tr[data-m]').forEach(tr => tr.addEventListener('click', () => { S.txFilter = { merchant: tr.dataset.m, all: true }; go('transactions'); }));
};

// ---------- Rapporten ----------
V.reports = async () => {
  const n = S.reportMonths || 12;
  const r = await GET(`/report?month=${S.month}&months=${n}`);
  const income = r.rows.filter(x => x.kind === 'income'), exp = r.rows.filter(x => x.kind === 'expense');
  const sum = a => a.reduce((x, y) => x + y, 0);
  const cellStyle = (v, max, good) => v ? `background:color-mix(in srgb,${good ? 'var(--good)' : 'var(--bad)'} ${Math.round(Math.min(1, Math.abs(v) / (max || 1)) * 34)}%,transparent)` : '';
  const line = (x, good) => { const mx = Math.max(...x.values.map(Math.abs), 1);
    return `<tr><td class="nowrap">${x.icon} ${esc(x.name)}</td>${x.values.map((v, i) => `<td class="num cell" data-cat="${x.id}" data-month="${r.months[i]}" style="${cellStyle(v, mx, good)}">${v ? num0(v) : '<span class="faint">·</span>'}</td>`).join('')}<td class="num muted">${num0(Math.round(sum(x.values) / n))}</td><td class="num"><b>${num0(sum(x.values))}</b></td></tr>`; };
  const groups = [...new Set(exp.map(x => x.grp))];
  const incT = r.totals.map(t => t.income), expT = r.totals.map(t => t.expenses);
  const m = render(`<div class="row between" style="margin-bottom:14px"><span class="muted">Bedragen in euro's, per categorie per maand. Klik op een cel voor de transacties.</span>
    <div class="seg" id="rm">${[6, 12, 24].map(v => `<button data-v="${v}" class="${n === v ? 'on' : ''}">${v} mnd</button>`).join('')}</div></div>
    <div class="card" style="padding:0"><div class="tablewrap"><table class="heat"><thead><tr><th>Categorie</th>${r.months.map(mo => `<th class="num">${monthShort(mo)}<br><span style="font-weight:400">${mo.slice(2, 4)}</span></th>`).join('')}<th class="num">Gem.</th><th class="num">Totaal</th></tr></thead><tbody>
    <tr class="group"><td colspan="${n + 3}">Inkomen</td></tr>${income.map(x => line(x, true)).join('')}
    ${groups.map(g => `<tr class="group"><td colspan="${n + 3}">${esc(g)}</td></tr>${exp.filter(x => x.grp === g).map(x => line(x, false)).join('')}`).join('')}
    ${sum(r.uncategorized) ? `<tr class="group"><td colspan="${n + 3}">Niet ingedeeld</td></tr><tr><td>❔ Zonder categorie</td>${r.uncategorized.map(v => `<td class="num">${v ? num0(v) : '·'}</td>`).join('')}<td class="num muted">${num0(Math.round(sum(r.uncategorized) / n))}</td><td class="num"><b>${num0(sum(r.uncategorized))}</b></td></tr>` : ''}
    <tr class="total"><td>Inkomsten</td>${incT.map(v => `<td class="num pos">${num0(v)}</td>`).join('')}<td class="num muted">${num0(Math.round(sum(incT) / n))}</td><td class="num pos">${num0(sum(incT))}</td></tr>
    <tr class="total"><td style="border-top:0">Uitgaven</td>${expT.map(v => `<td class="num" style="border-top:0">${num0(v)}</td>`).join('')}<td class="num muted" style="border-top:0">${num0(Math.round(sum(expT) / n))}</td><td class="num" style="border-top:0">${num0(sum(expT))}</td></tr>
    <tr class="total"><td style="border-top:0">Netto</td>${incT.map((v, i) => `<td class="num ${v - expT[i] < 0 ? 'neg' : 'pos'}" style="border-top:0">${num0(v - expT[i])}</td>`).join('')}<td class="num muted" style="border-top:0">${num0(Math.round((sum(incT) - sum(expT)) / n))}</td><td class="num ${sum(incT) - sum(expT) < 0 ? 'neg' : 'pos'}" style="border-top:0">${num0(sum(incT) - sum(expT))}</td></tr>
    </tbody></table></div></div>`);
  $('#rm').addEventListener('click', e => { if (e.target.dataset.v) { S.reportMonths = +e.target.dataset.v; V.reports(); } });
  m.querySelectorAll('td.cell').forEach(td => td.addEventListener('click', () => { S.txFilter = { category: td.dataset.cat, month: td.dataset.month }; S.month = td.dataset.month; go('transactions'); }));
};

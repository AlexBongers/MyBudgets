'use strict';
// Inzichten: patronen die de app zelf in al je transacties vindt (src/insights.js). Bovenaan de bevindingen,
// daaronder per onderwerp de onderbouwing.
V.insights = async () => {
  const d = await GET('/insights');
  if (!d.enough) return render(`<div class="hero"><div class="big">🔎</div><h2>Nog te weinig gegevens</h2><p>${esc(d.reason)}</p></div>`);
  const p = d.period, s = d.summary, cur = s.cur;
  const sec = (id, title, right, body, wide) => `<section class="card ins-sec${wide ? ' wide' : ''}" id="ins-${id}"><h2>${title}${right ? `<span class="right">${right}</span>` : ''}</h2>${body}</section>`;
  const yearBars = (ys, color = 'var(--exp)') => { const max = Math.max(1, ...ys.map(y => y.total)); return `<div class="ybars">${ys.map(y => `<div><span class="muted">${y.year}</span><div class="bar"><i style="width:${Math.max(y.total ? 2 : 0, y.total / max * 100)}%;background:${color}"></i></div><b class="num">${eur0(y.total)}</b>${y.n != null ? `<span class="faint small num">${y.n}×</span>` : ''}</div>`).join('')}</div>`; };
  const arrow = (a, b, fmt) => `<span class="muted">${fmt(a)}</span> → <b>${fmt(b)}</b>`;
  const x1 = v => String(v).replace('.', ',');
  const maxShift = Math.max(1, ...d.shifts.map(x => Math.abs(x.diff)));
  const toneIcon = { good: '↗', warn: '!', info: 'i' };

  const m = render(`
    <p class="ins-lead">Gezocht in <b>${p.months} maanden</b> aan transacties (${monthName(p.from)} t/m ${monthName(p.to)}). Overboekingen tussen je eigen rekeningen tellen niet mee${p.lastDate.slice(0, 7) > p.to ? `; de lopende maand is nog niet compleet en blijft buiten beschouwing` : ''}.</p>
    <div class="find-grid">${d.findings.map((f, i) => `<button class="finding ${f.tone}${i === 0 ? ' lead' : ''}" data-sec="${f.section}">
      <span class="kick"><i>${toneIcon[f.tone]}</i>${esc(f.kicker)}</span><span class="val">${esc(f.value)}</span><b>${esc(f.title)}</b><span class="txt">${esc(f.text)}</span></button>`).join('')}</div>

    <div class="ins-grid">
    ${sec('trend', 'Saldo over twaalf maanden', 'elke punt = de 12 maanden tot dan', d.rolling.length > 1 ? signedLine(d.rolling) : '<div class="empty">Zichtbaar vanaf twaalf maanden aan gegevens.</div>'
      , true)}
    ${sec('years', 'Per jaar', '', `<table class="st"><thead><tr><th>Jaar</th><th class="num">Inkomsten</th><th class="num">Uitgaven</th><th class="num">Saldo</th><th class="num">Spaarquote</th></tr></thead><tbody>
      ${d.years.map(y => `<tr><td class="c1">${y.year}${y.months < 12 ? ` <span class="faint small">${y.months} mnd</span>` : ''}</td><td class="num sm" data-l="in">${eur0(y.income)}</td><td class="num sm" data-l="uit">${eur0(y.expenses)}</td><td class="num ${y.net >= 0 ? 'pos' : 'neg'}"><b>${eurSigned(Math.round(y.net / 100) * 100).replace(/,00$/, '')}</b></td><td class="num sm">${y.rate != null ? y.rate + '%' : '–'}</td></tr>`).join('')}</tbody></table>
      ${d.forecast ? `<p class="muted small" style="margin:12px 0 0">Verwachting ${d.forecast.year}: <b style="color:var(--text)">${eurSigned(Math.round(d.forecast.expected / 100) * 100).replace(/,00$/, '')}</b>, op basis van dit jaar tot nu toe (${eurSigned(Math.round(d.forecast.ytd / 100) * 100).replace(/,00$/, '')}) en hoe ${d.forecast.rest.map(r => r.name).join(', ')} eerder verliepen.</p>` : ''}`)}
    ${sec('season', 'Een gemiddeld jaar, maand voor maand', 'saldo per kalendermaand, zonder eenmalige posten',
      signedBars(d.season.map(x => ({ label: x.name.slice(0, 3), value: x.net, mark: d.bonusMonths.includes(x.month), tip: `${x.name}: gemiddeld ${eurSigned(x.net)} (in ${eur0(x.income)}, uit ${eur0(x.expenses)}; ${x.n} jaar)` })))
      + `<p class="muted small" style="margin:8px 0 0">${d.bonusMonths.length ? `Vetgedrukte maanden hebben structureel extra inkomen. ` : ''}Blauw = er blijft geld over, koraal = er gaat meer uit dan er binnenkomt.</p>`)}
    ${d.shifts.length ? sec('shifts', 'Verschuivingen', `laatste 12 maanden t.o.v. de 12 daarvoor`, `<div class="divs">${d.shifts.map(x => `<div class="divrow" data-cat="${x.id ?? ''}"><span class="ellipsis">${x.icon} ${esc(x.name)}</span>
        <span class="divbar"><i class="${x.diff > 0 ? 'up' : 'down'}" style="width:${Math.max(1.5, Math.abs(x.diff) / maxShift * 50)}%"></i></span><b class="num ${x.diff > 0 ? 'neg' : 'pos'}">${eurSigned(Math.round(x.diff / 100) * 100).replace(/,00$/, '')}</b></div>`).join('')}</div>
        <p class="muted small" style="margin:10px 0 0">Zonder eenmalige grote posten en contant geld. Tik op een categorie voor de details.</p>`, true) : ''}
    ${d.habits.length ? sec('habits', 'Gewoontes: hoe vaak en hoe duur', p.hasPrev ? 'eerder → nu' : 'laatste 12 maanden', `<table class="st"><thead><tr><th>Categorie</th><th class="num">Keer per maand</th><th class="num">Per keer</th><th class="num">Per maand</th></tr></thead><tbody>
      ${d.habits.map(h => `<tr data-cat="${h.id}"><td class="c1 cf">${h.icon} ${esc(h.name)}</td><td class="num sm" data-l="keer p/m">${h.hasPrev ? arrow(h.prevPerMonth, h.perMonth, x1) : `<b>${x1(h.perMonth)}</b>`}</td><td class="num sm" data-l="per keer">${h.hasPrev ? arrow(h.prevTicket, h.ticket, eur0) : `<b>${eur0(h.ticket)}</b>`}</td><td class="num"><b>${eur0(h.monthly)}</b>${h.hasPrev && Math.abs(h.monthly - h.prevMonthly) >= 500 ? ` ${deltaChip(h.monthly, h.prevMonthly, true).replace('≈ vorige maand', '≈')}` : ''}</td></tr>`).join('')}</tbody></table>`, true) : ''}
    ${d.fixed.creep.length || d.fixed.ended.length || d.fixed.started.length ? sec('fixed', 'Vaste lasten in beweging', `nu ${eur0(d.fixed.monthly)} per maand`, `
      ${d.fixed.creep.length ? `<h3>Prijs veranderd</h3><table class="st"><tbody>${d.fixed.creep.map(c => `<tr data-payee="${esc(c.merchant)}"><td class="c1">${c.icon} ${esc(c.name)}</td><td class="num sm">${arrow(c.from, c.to, eur0)}</td><td class="num ${c.yearly > 0 ? 'neg' : 'pos'}"><b>${eurSigned(Math.round(c.yearly / 100) * 100).replace(/,00$/, '')}</b><span class="faint small">/jr</span></td></tr>`).join('')}</tbody></table>` : ''}
      ${d.fixed.ended.length ? `<h3>Gestopt</h3><table class="st"><tbody>${d.fixed.ended.map(c => `<tr data-payee="${esc(c.merchant)}"><td class="c1">${c.icon} ${esc(c.name)}</td><td class="sm muted">tot ${fmtDate(c.last)}</td><td class="num pos"><b>−${eur0(c.monthly)}</b><span class="faint small">/mnd</span></td></tr>`).join('')}</tbody></table>` : ''}
      ${d.fixed.started.length ? `<h3>Nieuw dit jaar</h3><table class="st"><tbody>${d.fixed.started.map(c => `<tr data-payee="${esc(c.merchant)}"><td class="c1">${c.icon} ${esc(c.name)}</td><td class="sm muted">sinds ${fmtDate(c.since)}</td><td class="num neg"><b>+${eur0(c.monthly)}</b><span class="faint small">/mnd</span></td></tr>`).join('')}</tbody></table>` : ''}`) : ''}
    ${d.oneOffs.list.length ? sec('oneoff', 'Eenmalige grote uitgaven', `vanaf ${eur0(d.oneOffs.min)}`, `${yearBars(d.oneOffs.years)}
      <table class="st" style="margin-top:12px"><tbody>${d.oneOffs.list.map(o => `<tr data-tx="${o.id}"><td class="sm muted nowrap">${fmtDate(o.date)}</td><td class="c1">${esc(o.payee)}<div class="small muted">${o.icon} ${esc(o.category)}</div></td><td class="num"><b>${eur0(o.amount)}</b></td></tr>`).join('')}</tbody></table>`) : ''}
    ${d.merchants.length ? sec('merchants', 'Waar je vrije uitgaven heen gaan', `laatste 12 maanden · ${eur0(d.variableTotal)}`, `<div class="divs">${d.merchants.map(x => `<div class="mrow" data-payee="${esc(x.merchant)}"><span class="ellipsis">${x.icon} ${esc(x.name)} <span class="faint small">${x.n}× · ${eur0(x.avg)}</span></span><span class="bar"><i style="width:${Math.max(2, x.total / d.merchants[0].total * 100)}%;background:${x.color}"></i></span><b class="num">${eur0(x.total)}</b></div>`).join('')}</div>`) : ''}
    ${d.weekdays.some(w => w.n) ? sec('weekday', 'Weekritme', 'vrije uitgaven per gemiddelde dag', signedBars(d.weekdays.map(w => ({ label: w.day, value: w.perDay, tip: `${w.day}: ${eur0(w.perDay)} per dag, ${w.n} betalingen van gemiddeld ${eur0(w.ticket)}` })), { height: 170 })) : ''}
    ${d.cash.n ? sec('cash', 'Contant geld', `${d.cash.n} opnames · ${eur0(d.cash.total)}`, yearBars(d.cash.years, 'var(--warn)')) : ''}
    ${d.bnpl.n ? sec('bnpl', 'Achteraf betalen', `${d.bnpl.n} betalingen · ${eur0(d.bnpl.total)}`, yearBars(d.bnpl.years, 'var(--exp)') + `<p class="muted small" style="margin:10px 0 0">Klarna, Riverty, AfterPay, Billink, in3 en vergelijkbare diensten.</p>`) : ''}
    ${d.returns.top.length ? sec('returns', 'Retouren', `laatste 12 maanden · ${eur0(d.returns.returned)} terug`, `<table class="st"><thead><tr><th>Winkel</th><th class="num">Gekocht</th><th class="num">Terug</th><th class="num">Aandeel</th></tr></thead><tbody>${d.returns.top.map(r => `<tr><td class="c1 cf">${esc(r.name)}</td><td class="num sm" data-l="gekocht">${eur0(r.bought)}</td><td class="num sm" data-l="terug">${eur0(r.returned)}</td><td class="num"><b>${r.ratio}%</b></td></tr>`).join('')}</tbody></table>`) : ''}
    ${d.small.n ? sec('small', 'Kleine bedragen', `onder € 25 · laatste 12 maanden`, `<div class="row" style="gap:6px 22px;margin-bottom:10px"><span><b class="bignum">${d.small.n}</b> <span class="muted">betalingen</span></span><span><b class="bignum">${eur0(d.small.total)}</b> <span class="muted">samen</span></span></div>
      <div class="divs">${d.small.top.map(x => `<div class="mrow"><span class="ellipsis">${esc(x.name)} <span class="faint small">${x.n}×</span></span><span class="bar"><i style="width:${Math.max(2, x.total / d.small.top[0].total * 100)}%;background:var(--faint)"></i></span><b class="num">${eur0(x.total)}</b></div>`).join('')}</div>`) : ''}
    ${d.quality.uncategorized ? sec('quality', 'Hoe betrouwbaar is dit?', '', `<p style="margin:0 0 8px"><b>${d.quality.uncategorized}</b> transacties (${d.quality.share}%) hebben geen categorie: ${eur0(d.quality.inflow)} bij en ${eur0(d.quality.outflow)} af. Zonder categorie telt een bijschrijving als inkomen en een afschrijving als uitgave.</p>
      ${d.quality.topInflow.length ? `<div class="divs">${d.quality.topInflow.map(x => `<div class="mrow" data-payee="${esc(x.merchant)}"><span class="ellipsis">${esc(x.name)} <span class="faint small">${x.n}×</span></span><span></span><b class="num">${eur0(x.total)}</b></div>`).join('')}</div>` : ''}
      <button class="btn sm" id="touncat" style="margin-top:10px">Toon transacties zonder categorie</button>`) : ''}
    </div>`);
  m.querySelectorAll('.finding').forEach(b => b.addEventListener('click', () => { const t = $('#ins-' + b.dataset.sec); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1400); } }));
  m.querySelectorAll('[data-cat]').forEach(el => el.addEventListener('click', () => el.dataset.cat && openCategory(+el.dataset.cat)));
  m.querySelectorAll('[data-payee]').forEach(el => el.addEventListener('click', () => openMerchant(el.dataset.payee)));
  m.querySelectorAll('[data-tx]').forEach(el => el.addEventListener('click', () => txDetail(+el.dataset.tx)));
  $('#touncat')?.addEventListener('click', () => { S.txFilter = { category: 'none', all: true }; go('transactions'); });
};

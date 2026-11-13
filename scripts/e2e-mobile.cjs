// Mobiele en foldable-controle van de browserversie (servermodus): start een eigen server met tijdelijke database,
// laadt voorbeelddata en loopt alle schermen langs op telefoon-, cover-, uitgevouwen- en desktopbreedte.
//   npm run e2e:mobile        (Chromium van Playwright; of MYB_CHROME=/pad/naar/chrome)
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const VIEWPORTS = { telefoon: [390, 844], cover: [344, 882], flip: [412, 915], uitgevouwen: [690, 829], pixelfold: [841, 701], liggend: [844, 390], desktop: [1366, 860] };
const VIEWS = ['dashboard', 'review', 'transactions', 'budget', 'recurring', 'reports', 'year', 'categories', 'settings', 'import'];

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybudgets-mob-')), port = 3600 + Math.floor(Math.random() * 300);
  const srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, PORT: String(port), DB_PATH: path.join(tmp, 'b.db'), MYBUDGETS_BACKUPS: '0' }, stdio: 'ignore' });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/healthz'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  await fetch(base + '/api/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const browser = await chromium.launch(process.env.MYB_CHROME ? { executablePath: process.env.MYB_CHROME } : {});
  let failed = 0; const ok = (label, v) => { if (!v) failed++; console.log((v ? '✓ ' : '✗ ') + label); };
  const errs = [];
  try {
    for (const [name, [w, h]] of Object.entries(VIEWPORTS)) {
      const mob = name !== 'desktop';
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mob, hasTouch: mob });
      const p = await ctx.newPage(); p.on('pageerror', e => errs.push(`${name}: ${e.message}`));
      await p.goto(base); await p.waitForSelector('#main .page');
      const bad = [];
      for (const v of VIEWS) {
        await p.evaluate(v => { S.txFilter = {}; return go(v); }, v); await p.waitForTimeout(250);
        if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)) bad.push(v);
      }
      ok(`${name} (${w}×${h}): geen horizontale scroll op ${VIEWS.length} schermen${bad.length ? ' — ' + bad.join(', ') : ''}`, !bad.length);
      const nav = w < 600 ? '#tabbar' : '#nav';
      ok(`${name}: navigatie zichtbaar (${w < 600 ? 'tabbalk' : w < 1100 ? 'rail' : 'zijbalk'})`, await p.locator(nav).isVisible());
      await ctx.close();
    }
    // telefoon: Meer-sheet, filters, snel wisselen, uit-/dichtvouwen
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await ctx.newPage(); p.on('pageerror', e => errs.push('interactie: ' + e.message));
    await p.goto(base); await p.waitForSelector('#main .page');
    await p.tap('#tabbar [data-more]'); await p.waitForSelector('.more-grid');
    ok('Meer-sheet toont de overige schermen', (await p.locator('.more-grid button').count()) === 7);
    await p.tap('.more-grid [data-tab=year]'); await p.waitForSelector('#yseg');
    ok('Meer blijft actief op een scherm uit de sheet', (await p.locator('#tabbar [data-more].on').count()) === 1);
    await p.tap('#tabbar [data-tab=transactions]'); await p.waitForSelector('#rows tr');
    await p.tap('#ftoggle'); ok('filters uitklappen', (await p.locator('.filters.open').count()) === 1);
    await p.evaluate(() => { go('reports'); go('year'); go('budget'); go('recurring'); }); await p.waitForTimeout(1500);
    ok('snel wisselen eindigt op het laatst gekozen scherm', (await p.textContent('#title')) === 'Vaste lasten');
    await p.tap('#tabbar [data-tab=dashboard]'); await p.waitForSelector('.chart svg');
    const w1 = await p.evaluate(() => document.querySelector('.chart svg').viewBox.baseVal.width);
    await p.setViewportSize({ width: 690, height: 829 }); await p.waitForTimeout(900);
    const w2 = await p.evaluate(() => document.querySelector('.chart svg').viewBox.baseVal.width);
    ok(`uitvouwen: grafieken opnieuw op de nieuwe breedte (${w1} → ${w2}), rail i.p.v. tabbalk`, w2 > w1 + 100 && await p.locator('#nav').isVisible() && !(await p.locator('#tabbar').isVisible()));
    await p.setViewportSize({ width: 344, height: 882 }); await p.waitForTimeout(900);
    ok('dichtvouwen: tabbalk terug', await p.locator('#tabbar').isVisible());
    await ctx.close();
    ok('geen fouten in de pagina', errs.length === 0); if (errs.length) console.log(errs);
  } finally {
    await browser.close(); srv.kill();
    await new Promise(r => (srv.exitCode !== null ? r() : srv.once('exit', r)));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tijdelijke map; niet erg */ }
  }
  console.log(failed ? `\n${failed} controle(s) mislukt` : '\nAlles geslaagd'); process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FOUT', e.message); process.exit(1); });

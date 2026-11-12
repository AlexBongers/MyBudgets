// End-to-end: start de echte Electron-app en doorloop de belangrijkste gebruikersflows.
//   npm run e2e            (macOS/Windows)
//   xvfb-run -a npm run e2e   (headless Linux)
// Gebruikt een tijdelijke database en gebruikersmap, dus je eigen gegevens blijven onaangeroerd.
const { _electron } = require('playwright-core');
const electronPath = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybudgets-e2e-'));
  const env = { ...process.env, MYBUDGETS_DB: path.join(tmp, 'budget.db') }; delete env.NODE_OPTIONS;
  const app = await _electron.launch({ executablePath: electronPath, args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--user-data-dir=${tmp}/ud`, path.join(__dirname, '..')], env });
  const win = await app.firstWindow(); const errs = [];
  win.on('pageerror', e => errs.push(e.message)); win.on('console', m => m.type() === 'error' && errs.push(m.text()));
  let failed = 0; const ok = (label, v) => { if (!v) failed++; console.log((v ? '✓ ' : '✗ ') + label); };

  await win.waitForSelector('.hero'); ok('lege staat toont welkom', true);
  await win.click('[data-act=demo]'); await win.waitForSelector('.kpi'); ok('voorbeelddata geladen', (await win.locator('.kpi').count()) >= 4);
  ok('saldo-verloop zichtbaar', (await win.locator('svg[aria-label="Saldo-verloop"]').count()) === 1);

  await win.click('[data-tab=review]'); await win.waitForSelector('.rv'); const n0 = await win.locator('.rv').count();
  await win.keyboard.press('j'); await win.keyboard.press('j'); await win.keyboard.press('Enter'); await win.waitForTimeout(900);
  ok('review: suggestie bevestigen met toetsenbord', (await win.locator('.rv').count()) < n0);
  await win.click('.toast-btn'); await win.waitForTimeout(900); ok('ongedaan maken herstelt de groep', (await win.locator('.rv').count()) === n0);

  await win.keyboard.press('Control+k'); await win.waitForSelector('#pq'); await win.keyboard.type('woonbron'); await win.waitForTimeout(400); await win.keyboard.press('Enter'); await win.waitForTimeout(700);
  ok('opdrachtpalet opent tegenpartij-overzicht', (await win.textContent('#title')).includes('Woonbron'));

  await win.click('[data-tab=budget]'); await win.waitForSelector('input[data-cat]');
  await win.click('#fill'); await win.waitForTimeout(500); ok('budget aanvullen met gemiddelde', (await win.locator('input[data-cat]').evaluateAll(a => a.filter(i => Number(i.value) > 0).length)) > 0);

  await win.click('[data-tab=recurring]'); await win.waitForSelector('tr[data-m]'); ok('vaste lasten herkend', (await win.locator('tr[data-m]').count()) >= 8);
  await win.click('[data-tab=reports]'); await win.waitForSelector('.heat'); ok('rapport toont spaarquote', (await win.innerText('.heat')).includes('Spaarquote'));

  // Notion-import via de native bestandsdialoog (gestubd): bestaande Rabobank-transacties worden verrijkt
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, path.join(__dirname, '..', 'samples', 'notion-demo.zip'));
  await win.evaluate(() => go('notion')); await win.waitForSelector('#ndz'); await win.click('#ndz'); await win.waitForSelector('#nplan table');
  ok('notion: tabellen herkend', (await win.locator('#ntabs button').count()) === 2);
  ok('notion: voorbeeld toont verrijking', (await win.innerText('#nplan')).includes('622 bestaande verrijkt'));
  await win.click('#ngo'); await win.waitForSelector('.hero h2'); ok('notion: import klaar', (await win.innerText('.hero .card')).includes('622 bestaande transacties verrijkt'));

  await win.click('[data-tab=settings]'); await win.waitForSelector('#theme');
  ok('importgeschiedenis aanwezig', (await win.locator('[data-undo-import]').count()) >= 1);
  await win.click('#theme [data-v=dark]'); ok('donker thema', (await win.evaluate(() => document.documentElement.dataset.theme)) === 'dark');

  const pdf = path.join(tmp, 'scherm.pdf');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, pdf);
  ok('pdf-export', (await win.evaluate(() => window.native.exportPDF('x.pdf'))) && fs.readFileSync(pdf).subarray(0, 4).toString() === '%PDF');

  ok('geen fouten in de console', errs.length === 0); if (errs.length) console.log(errs);
  await app.close();
  ok('automatische back-up gemaakt bij afsluiten', fs.existsSync(`${tmp}/ud/backups`) && fs.readdirSync(`${tmp}/ud/backups`).length === 1);
  console.log(failed ? `\n${failed} controle(s) mislukt` : '\nAlles geslaagd'); process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FOUT', e.message); process.exit(1); });

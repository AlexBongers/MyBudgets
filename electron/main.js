import { app, BrowserWindow, ipcMain, dialog, Menu, shell, session, nativeTheme, screen, safeStorage } from 'electron';
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, backupTo } from '../src/db.js';
import { createApi, demoCSVFrom } from '../src/service.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const isMac = process.platform === 'darwin';
app.setName('MyBudgets');
app.setAboutPanelOptions({ applicationName: 'MyBudgets', applicationVersion: app.getVersion(), copyright: 'Lokaal en privé: je gegevens verlaten je Mac nooit.' });

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null, db = null, api = null;
const pendingFiles = [];
const dbPath = process.env.MYBUDGETS_DB || join(app.getPath('userData'), 'budget.db');

// De parser herkent de codering zelf (UTF-8 / ISO-8859-1); we sturen daarom de ruwe bytes door.
const readCSV = p => ({ name: basename(p), base64: readFileSync(p).toString('base64') });
const send = (m) => win && !win.isDestroyed() && win.webContents.send('menu', m);

function startDb() {
  db = openDb(dbPath);
  api = createApi(db, { demoCSV: demoCSVFrom(join(ROOT, 'samples/rabobank-demo.csv')) });
}

// Vensterpositie en -grootte onthouden
const statePath = join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try {
    const b = JSON.parse(readFileSync(statePath, 'utf8'));
    const visible = screen.getAllDisplays().some(d => b.x >= d.bounds.x - 50 && b.y >= d.bounds.y - 50 && b.x < d.bounds.x + d.bounds.width - 100 && b.y < d.bounds.y + d.bounds.height - 100);
    return visible ? b : { width: b.width, height: b.height };
  } catch { return {}; }
}
function saveBounds() { try { if (win && !win.isMinimized() && !win.isFullScreen()) writeFileSync(statePath, JSON.stringify(win.getBounds())); } catch { /* niet kritiek */ } }

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, ...loadBounds(), minWidth: 1000, minHeight: 640, show: false,
    title: 'MyBudgets',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: isMac ? 'sidebar' : undefined, visualEffectState: 'followWindow',
    backgroundColor: isMac ? '#00000000' : undefined,
    webPreferences: { preload: join(ROOT, 'electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', saveBounds);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('did-finish-load', () => { while (pendingFiles.length) send({ action: 'import-files', files: [readCSV(pendingFiles.shift())] }); });
  win.loadFile(join(ROOT, 'renderer/index.html'));
}

ipcMain.handle('api', async (_e, method, url, body) => {
  try { return { data: await api(method, url, body || {}) }; }
  catch (e) { return { __error: true, status: e.status || 500, message: e.message }; }
});
ipcMain.handle('dialog:open-notion', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Notion-export kiezen', properties: ['openFile'], filters: [{ name: 'Notion-export (ZIP of CSV)', extensions: ['zip', 'csv'] }] });
  return r.canceled ? [] : r.filePaths.map(p => ({ name: basename(p), base64: readFileSync(p).toString('base64') }));
});
ipcMain.handle('dialog:open', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Rabobank CSV kiezen', properties: ['openFile', 'multiSelections'], filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }] });
  return r.canceled ? [] : r.filePaths.map(readCSV);
});
ipcMain.handle('dialog:save', async (_e, name, text) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name });
  if (r.canceled || !r.filePath) return false;
  writeFileSync(r.filePath, text, 'utf8'); return true;
});
const backupDir = () => { const d = join(app.getPath('userData'), 'backups'); mkdirSync(d, { recursive: true }); return d; };
ipcMain.handle('db:backup', async () => {
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win, { defaultPath: `MyBudgets-backup-${stamp}.db`, filters: [{ name: 'Database', extensions: ['db'] }] });
  if (r.canceled || !r.filePath) return false;
  backupTo(db, r.filePath);
  return true;
});

// Herstellen: eerst controleren dat het echt een MyBudgets-database is, dan een veiligheidskopie van de huidige gegevens maken.
function validBackup(path) {
  let t = null;
  try { t = new DatabaseSync(path, { readOnly: true }); return t.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('transactions','categories')").get().c === 2; }
  catch { return false; } finally { try { t?.close(); } catch { /* niets */ } }
}
async function restoreFrom(file) {
  if (!validBackup(file)) { await dialog.showMessageBox(win, { type: 'error', message: 'Dit is geen geldige MyBudgets-back-up.' }); return false; }
  const ok = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Annuleren', 'Vervangen'], defaultId: 0, cancelId: 0,
    message: 'Back-up herstellen?', detail: 'Je huidige gegevens worden vervangen door de back-up. Er wordt eerst een veiligheidskopie van je huidige gegevens gemaakt. De app start daarna opnieuw.' });
  if (ok.response !== 1) return false;
  backupTo(db, join(backupDir(), `voor-herstel-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
  db.close(); copyFileSync(file, dbPath);
  for (const ext of ['-wal', '-shm']) if (existsSync(dbPath + ext)) unlinkSync(dbPath + ext);
  app.relaunch(); app.exit(0); return true;
}
ipcMain.handle('db:restore', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Back-up kiezen', properties: ['openFile'], filters: [{ name: 'Database', extensions: ['db'] }] });
  return r.canceled || !r.filePaths[0] ? false : restoreFrom(r.filePaths[0]);
});
ipcMain.handle('backups:list', () => {
  try { const d = backupDir(); return readdirSync(d).filter(f => f.endsWith('.db')).map(f => ({ name: f, size: statSync(join(d, f)).size, mtime: statSync(join(d, f)).mtimeMs })).sort((x, y) => y.mtime - x.mtime); }
  catch { return []; }
});
ipcMain.handle('backups:restore', (_e, name) => (/^[\w.-]+\.db$/.test(name) ? restoreFrom(join(backupDir(), name)) : false));
ipcMain.handle('backups:reveal', () => { shell.openPath(backupDir()); return true; });

// Dagelijkse automatische back-up (laatste 14 bewaard; 'voor-herstel'-kopieën worden nooit automatisch gewist)
function autoBackup() {
  try {
    if (!db || db.prepare('SELECT COUNT(*) c FROM transactions').get().c === 0) return;
    const dir = backupDir(), file = join(dir, `budget-${new Date().toISOString().slice(0, 10)}.db`);
    if (!existsSync(file)) backupTo(db, file);
    const all = readdirSync(dir).filter(f => /^budget-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - 14))) unlinkSync(join(dir, f));
  } catch (e) { console.error('Automatische back-up mislukt:', e); }
}
// Het huidige scherm als PDF (print-CSS verbergt zijbalk en knoppen)
ipcMain.handle('export:pdf', async (_e, name) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name || 'MyBudgets.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return false;
  const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
  writeFileSync(r.filePath, pdf); return true;
});
// Notion-token: versleuteld met de macOS-Sleutelhanger (safeStorage), nooit leesbaar op schijf
const tokenFile = () => join(app.getPath('userData'), 'notion-token.bin');
ipcMain.handle('secret:get', () => { try { return existsSync(tokenFile()) && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(readFileSync(tokenFile())) : ''; } catch { return ''; } });
ipcMain.handle('secret:set', (_e, v) => {
  try {
    if (!v) { if (existsSync(tokenFile())) unlinkSync(tokenFile()); return true; }
    if (!safeStorage.isEncryptionAvailable()) return false;
    writeFileSync(tokenFile(), safeStorage.encryptString(String(v))); return true;
  } catch { return false; }
});
ipcMain.handle('theme:set', (_e, t) => { nativeTheme.themeSource = ['light', 'dark'].includes(t) ? t : 'system'; return true; });
ipcMain.handle('shell:reveal', () => { shell.showItemInFolder(dbPath); return true; });

function buildMenu() {
  const nav = (label, tab, n) => ({ label, accelerator: `CmdOrCtrl+${n}`, click: () => send({ action: 'nav', tab }) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'about', label: 'Over MyBudgets' }, { type: 'separator' }, { role: 'services', label: 'Services' }, { type: 'separator' }, { role: 'hide', label: 'Verberg MyBudgets' }, { role: 'hideOthers', label: 'Verberg andere' }, { role: 'unhide', label: 'Toon alles' }, { type: 'separator' }, { role: 'quit', label: 'Stop MyBudgets' }] }] : []),
    { label: 'Bestand', submenu: [
      { label: 'Rabobank CSV importeren…', accelerator: 'CmdOrCtrl+O', click: () => send({ action: 'import-dialog' }) },
      { label: 'Importeren uit Notion…', click: () => send({ action: 'notion' }) },
      { label: 'Transacties exporteren (CSV)…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send({ action: 'export' }) },
      { label: 'Dit scherm exporteren als PDF…', accelerator: 'CmdOrCtrl+P', click: () => send({ action: 'pdf' }) },
      { type: 'separator' },
      { label: 'Back-up maken…', click: () => send({ action: 'backup' }) },
      { label: 'Back-up herstellen…', click: () => send({ action: 'restore' }) },
      { type: 'separator' }, isMac ? { role: 'close', label: 'Sluit venster' } : { role: 'quit', label: 'Afsluiten' }] },
    { label: 'Bewerken', submenu: [{ label: 'Ongedaan maken', accelerator: 'CmdOrCtrl+Z', click: () => send({ action: 'undo' }) }, { role: 'redo', label: 'Opnieuw' }, { type: 'separator' }, { role: 'cut', label: 'Knip' }, { role: 'copy', label: 'Kopieer' }, { role: 'paste', label: 'Plak' }, { role: 'selectAll', label: 'Selecteer alles' },
      { type: 'separator' }, { label: 'Zoek en ga naar…', accelerator: 'CmdOrCtrl+K', click: () => send({ action: 'palette' }) }, { label: 'Zoeken in transacties', accelerator: 'CmdOrCtrl+F', click: () => send({ action: 'search' }) }] },
    { label: 'Weergave', submenu: [
      nav('Dashboard', 'dashboard', 1), nav('Te beoordelen', 'review', 2), nav('Transacties', 'transactions', 3), nav('Budget', 'budget', 4),
      nav('Vaste lasten', 'recurring', 5), nav('Rapporten', 'reports', 6), nav('Categorieën & regels', 'categories', 7), { type: 'separator' },
      { label: 'Vorige maand', accelerator: 'CmdOrCtrl+[', click: () => send({ action: 'month', delta: -1 }) },
      { label: 'Volgende maand', accelerator: 'CmdOrCtrl+]', click: () => send({ action: 'month', delta: 1 }) }, { type: 'separator' },
      { role: 'resetZoom', label: 'Standaardgrootte' }, { role: 'zoomIn', label: 'Inzoomen' }, { role: 'zoomOut', label: 'Uitzoomen' }, { type: 'separator' },
      { role: 'togglefullscreen', label: 'Volledig scherm' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }, { role: 'reload' }] : [])] },
    { label: 'Venster', submenu: [{ role: 'minimize', label: 'Minimaliseer' }, { role: 'zoom', label: 'Zoom' }, ...(isMac ? [{ type: 'separator' }, { role: 'front', label: 'Alles naar voren' }] : [])] },
    { label: 'Help', submenu: [{ label: 'Hoe exporteer ik uit Rabo Internetbankieren?', click: () => send({ action: 'nav', tab: 'import' }) },
      { label: 'Toon databestand in Finder', click: () => shell.showItemInFolder(dbPath) }] },
  ]));
}

app.on('open-file', (e, p) => { e.preventDefault(); if (win?.webContents && !win.webContents.isLoading()) send({ action: 'import-files', files: [readCSV(p)] }); else pendingFiles.push(p); });
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  if (isMac && !app.isPackaged) { try { app.dock.setIcon(join(ROOT, 'build/icon.png')); } catch { /* alleen cosmetisch in dev */ } }
  startDb(); autoBackup(); buildMenu(); createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
app.on('before-quit', () => { autoBackup(); try { db?.close(); } catch { /* al gesloten */ } });

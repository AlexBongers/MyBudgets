import { app, BrowserWindow, ipcMain, dialog, Menu, shell, session } from 'electron';
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createApi, demoCSVFrom } from '../src/service.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const isMac = process.platform === 'darwin';
app.setName('MyBudgets');

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

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1000, minHeight: 640, show: false,
    title: 'MyBudgets',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: isMac ? 'sidebar' : undefined, visualEffectState: 'followWindow',
    backgroundColor: isMac ? '#00000000' : undefined,
    webPreferences: { preload: join(ROOT, 'electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('did-finish-load', () => { while (pendingFiles.length) send({ action: 'import-files', files: [readCSV(pendingFiles.shift())] }); });
  win.loadFile(join(ROOT, 'renderer/index.html'));
}

ipcMain.handle('api', async (_e, method, url, body) => {
  try { return { data: await api(method, url, body || {}) }; }
  catch (e) { return { __error: true, status: e.status || 500, message: e.message }; }
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
ipcMain.handle('db:backup', async () => {
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win, { defaultPath: `MyBudgets-backup-${stamp}.db`, filters: [{ name: 'Database', extensions: ['db'] }] });
  if (r.canceled || !r.filePath) return false;
  if (existsSync(r.filePath)) unlinkSync(r.filePath);
  db.exec(`VACUUM INTO '${r.filePath.replace(/'/g, "''")}'`);
  return true;
});
ipcMain.handle('db:restore', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Back-up kiezen', properties: ['openFile'], filters: [{ name: 'Database', extensions: ['db'] }] });
  if (r.canceled || !r.filePaths[0]) return false;
  const ok = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Annuleren', 'Vervangen'], defaultId: 0, cancelId: 0,
    message: 'Back-up herstellen?', detail: 'Je huidige gegevens worden vervangen door de back-up. De app start daarna opnieuw.' });
  if (ok.response !== 1) return false;
  db.close(); copyFileSync(r.filePaths[0], dbPath);
  for (const ext of ['-wal', '-shm']) if (existsSync(dbPath + ext)) unlinkSync(dbPath + ext);
  app.relaunch(); app.exit(0); return true;
});
ipcMain.handle('shell:reveal', () => { shell.showItemInFolder(dbPath); return true; });

function buildMenu() {
  const nav = (label, tab, n) => ({ label, accelerator: `CmdOrCtrl+${n}`, click: () => send({ action: 'nav', tab }) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'about', label: 'Over MyBudgets' }, { type: 'separator' }, { role: 'services', label: 'Services' }, { type: 'separator' }, { role: 'hide', label: 'Verberg MyBudgets' }, { role: 'hideOthers', label: 'Verberg andere' }, { role: 'unhide', label: 'Toon alles' }, { type: 'separator' }, { role: 'quit', label: 'Stop MyBudgets' }] }] : []),
    { label: 'Bestand', submenu: [
      { label: 'Rabobank CSV importeren…', accelerator: 'CmdOrCtrl+O', click: () => send({ action: 'import-dialog' }) },
      { label: 'Transacties exporteren (CSV)…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send({ action: 'export' }) },
      { type: 'separator' },
      { label: 'Back-up maken…', click: () => send({ action: 'backup' }) },
      { label: 'Back-up herstellen…', click: () => send({ action: 'restore' }) },
      { type: 'separator' }, isMac ? { role: 'close', label: 'Sluit venster' } : { role: 'quit', label: 'Afsluiten' }] },
    { label: 'Bewerken', submenu: [{ label: 'Ongedaan maken', accelerator: 'CmdOrCtrl+Z', click: () => send({ action: 'undo' }) }, { role: 'redo', label: 'Opnieuw' }, { type: 'separator' }, { role: 'cut', label: 'Knip' }, { role: 'copy', label: 'Kopieer' }, { role: 'paste', label: 'Plak' }, { role: 'selectAll', label: 'Selecteer alles' },
      { type: 'separator' }, { label: 'Zoeken in transacties', accelerator: 'CmdOrCtrl+F', click: () => send({ action: 'search' }) }] },
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
  startDb(); buildMenu(); createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
app.on('before-quit', () => { try { db?.close(); } catch { /* al gesloten */ } });

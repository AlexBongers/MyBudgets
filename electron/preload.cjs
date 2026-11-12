const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('native', {
  platform: process.platform,
  async api(method, url, body) {
    const r = await ipcRenderer.invoke('api', method, url, body);
    if (r && r.__error) throw Object.assign(new Error(r.message), { status: r.status });
    return r.data;
  },
  openCSV: () => ipcRenderer.invoke('dialog:open'),
  saveFile: (name, text) => ipcRenderer.invoke('dialog:save', name, text),
  backup: () => ipcRenderer.invoke('db:backup'),
  restore: () => ipcRenderer.invoke('db:restore'),
  reveal: () => ipcRenderer.invoke('shell:reveal'),
  setTheme: t => ipcRenderer.invoke('theme:set', t),
  exportPDF: name => ipcRenderer.invoke('export:pdf', name),
  onMenu: cb => ipcRenderer.on('menu', (_e, m) => cb(m)),
});

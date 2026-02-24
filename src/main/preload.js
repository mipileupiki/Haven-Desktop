// ═══════════════════════════════════════════════════════════
// Haven Desktop — Welcome Window Preload
// Exposes IPC bridges for the welcome / setup screen.
// ═══════════════════════════════════════════════════════════

const { ipcRenderer } = require('electron');

window.haven = {
  platform: process.platform,

  // ── Server Management ──────────────────────────────────
  server: {
    detect:     ()          => ipcRenderer.invoke('server:detect'),
    start:      (dir)       => ipcRenderer.invoke('server:start', dir),
    stop:       ()          => ipcRenderer.invoke('server:stop'),
    browse:     ()          => ipcRenderer.invoke('server:browse'),
    browseFile: ()          => ipcRenderer.invoke('server:browse-file'),
    getStatus:  ()          => ipcRenderer.invoke('server:status'),
    onLog:      (cb)        => ipcRenderer.on('server:log', (_e, m) => cb(m)),
  },

  // ── Settings ───────────────────────────────────────────
  settings: {
    get: (key)       => ipcRenderer.invoke('settings:get', key),
    set: (key, val)  => ipcRenderer.invoke('settings:set', key, val),
  },

  // ── Window Controls (frameless title-bar buttons) ──────
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
  },

  // ── Navigation ─────────────────────────────────────────
  nav: {
    openApp: (serverUrl) => ipcRenderer.send('nav:open-app', serverUrl),
  },

  // ── Misc ───────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.send('open-external', url),
  getVersion:   ()    => ipcRenderer.invoke('app:version'),
};

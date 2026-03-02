// ═══════════════════════════════════════════════════════════
// Haven Desktop — Main Process
// ═══════════════════════════════════════════════════════════

const {
  app, BrowserWindow, BrowserView, ipcMain, Notification, Tray, Menu,
  nativeImage, desktopCapturer, session, dialog, shell, screen, globalShortcut
} = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const Store = require('electron-store');
const { ServerManager }      = require('./server-manager');
const { AudioCaptureManager } = require('./audio-capture');

// ── Auto-Updater (electron-updater) ───────────────────────
let autoUpdater;
try { ({ autoUpdater } = require('electron-updater')); } catch {}

// ── Constants ─────────────────────────────────────────────
// ── Enable native Wayland support (must be before app.whenReady) ──
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

const IS_DEV    = process.argv.includes('--dev');
const SHOW_SERVER = process.argv.includes('--show-server');
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');

// ── Persistent Store ──────────────────────────────────────
const store = new Store({
  defaults: {
    userPrefs: {
      mode: null,             // 'host' | 'join'
      serverUrl: null,        // last-connected server URL
      serverPath: null,       // path to Haven server dir (for hosting)
      skipWelcome: false,     // remember choice
      audioInput:  null,      // preferred mic device ID
      audioOutput: null,      // preferred speaker device ID
    },
    windowBounds: { width: 1200, height: 800 },
  },
});

// ── State ─────────────────────────────────────────────────
let mainWindow      = null;
let welcomeWindow   = null;
let tray            = null;
let serverManager   = null;
let audioCapture    = null;
let serverViews     = new Map();  // serverUrl → BrowserView
let activeServerUrl = null;
let primaryServerUrl = null;       // the server the user actually chose to connect to
let badgeIcon       = null;

// ── Single-Instance Lock ──────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => {
    const win = mainWindow || welcomeWindow;
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

// ═══════════════════════════════════════════════════════════
// Self-Signed Certificate Handling
//
// Haven servers often use self-signed certs for localhost.
// Accept them for local connections so the app can load.
// ═══════════════════════════════════════════════════════════

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  // Haven servers commonly use self-signed certs.
  // Accept them so users can connect to LAN / remote servers without a blank screen.
  event.preventDefault();
  callback(true);
});

// ═══════════════════════════════════════════════════════════
// App Lifecycle
// ═══════════════════════════════════════════════════════════

app.whenReady().then(async () => {
  serverManager = new ServerManager(store, { showConsole: SHOW_SERVER || IS_DEV });
  audioCapture  = new AudioCaptureManager();
  badgeIcon     = createBadgeIcon();

  // ── Auto-update check (issue #3) ──────────────────────
  if (autoUpdater) {
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', (info) => {
      const wc = getActiveContents() || welcomeWindow?.webContents;
      if (wc && !wc.isDestroyed()) wc.send('update:available', { version: info.version });
    });
    autoUpdater.on('download-progress', (progress) => {
      const wc = getActiveContents() || welcomeWindow?.webContents;
      if (wc && !wc.isDestroyed()) wc.send('update:download-progress', { percent: Math.round(progress.percent) });
    });
    autoUpdater.on('update-downloaded', () => {
      const wc = getActiveContents() || welcomeWindow?.webContents;
      if (wc && !wc.isDestroyed()) wc.send('update:downloaded');
    });
    autoUpdater.on('error', (err) => {
      console.error('[AutoUpdate] Error:', err.message);
      const wc = getActiveContents() || welcomeWindow?.webContents;
      if (wc && !wc.isDestroyed()) wc.send('update:error', { message: err.message });
    });
    autoUpdater.checkForUpdates().catch(() => {});
  }

  // ── Linux desktop integration (issue #3) ──────────────
  if (process.platform === 'linux') installLinuxDesktopEntry();

  // Forward server log lines to whichever renderer window is active
  serverManager.onLog((msg) => {
    const wc = getActiveContents() || welcomeWindow?.webContents;
    if (wc && !wc.isDestroyed()) wc.send('server:log', msg);
  });

  // Auto-grant camera, mic, and screen-share permissions for all server views
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const granted = ['media', 'mediaKeySystem', 'display-capture', 'notifications'].includes(permission);
    callback(granted);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return ['media', 'mediaKeySystem', 'display-capture', 'notifications'].includes(permission);
  });

  registerIPC();
  registerScreenShareHandler();

  const prefs = store.get('userPrefs');

  if (prefs.skipWelcome && prefs.mode && prefs.serverUrl) {
    // Returning user — remembered preferences
    if (prefs.mode === 'host' && prefs.serverPath) {
      const res = await serverManager.startServer(prefs.serverPath);
      if (!res.success) { createWelcomeWindow(); createTray(); return; }
      console.log(`[Haven Desktop] Server started at ${res.url} (port ${res.port})`);
      // Use the fresh URL (protocol may have changed between http/https)
      createAppWindow(res.url || prefs.serverUrl);
    } else {
      createAppWindow(prefs.serverUrl);
    }
  } else {
    createWelcomeWindow();
  }

  createTray();

  // ── Global shortcut: Ctrl+Shift+Home to reset to welcome screen ──
  // This is the escape hatch for users who are soft-locked into a broken server
  globalShortcut.register('CommandOrControl+Shift+Home', () => {
    if (mainWindow) resetToWelcome();
  });
});

// ── Reset to welcome screen (clears saved prefs) ─────────
function resetToWelcome() {
  serverManager?.stopServer();
  // Clean up all BrowserViews
  for (const [url, view] of serverViews) {
    mainWindow?.removeBrowserView(view);
    try { view.webContents.destroy(); } catch {}
  }
  serverViews.clear();
  activeServerUrl = null;
  primaryServerUrl = null;
  // Clear saved connection prefs so user isn't soft-locked
  store.set('userPrefs.skipWelcome', false);
  store.set('userPrefs.serverUrl', null);
  store.set('userPrefs.mode', null);
  mainWindow?.close();
  createWelcomeWindow();
  createTray();
}

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});

app.on('before-quit', () => {
  serverManager?.stopServer();
  audioCapture?.cleanup();
});

// ═══════════════════════════════════════════════════════════
// Window Factories
// ═══════════════════════════════════════════════════════════

function createWelcomeWindow() {
  welcomeWindow = new BrowserWindow({
    width: 720, height: 560,
    minWidth: 620, minHeight: 480,
    resizable: false,
    frame: false,
    backgroundColor: '#0d0d1a',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  welcomeWindow.loadFile(path.join(__dirname, '..', 'renderer', 'welcome.html'));
  welcomeWindow.once('ready-to-show', () => {
    welcomeWindow.show();
    if (IS_DEV) welcomeWindow.webContents.openDevTools({ mode: 'detach' });
  });
  welcomeWindow.on('closed', () => { welcomeWindow = null; });
}

function createAppWindow(serverUrl) {
  if (!mainWindow) {
    const bounds = store.get('windowBounds');
    mainWindow = new BrowserWindow({
      ...bounds,
      minWidth: 800, minHeight: 600,
      frame: true,
      backgroundColor: '#0d0d1a',
      icon: ICON_PATH,
      show: false,
    });

    const saveBounds = () => {
      if (!mainWindow) return;
      const b = mainWindow.getBounds();
      store.set('windowBounds', { width: b.width, height: b.height });
    };
    mainWindow.on('resize', saveBounds);
    mainWindow.on('move',   saveBounds);
    // Badge is cleared by the web app when unreads reach zero, not on raw focus.
    // Clearing on focus caused the overlay to vanish even while unreads remained.
    mainWindow.on('closed', () => {
      serverViews.clear();
      activeServerUrl = null;
      primaryServerUrl = null;
      mainWindow = null;
    });
  }

  // Track the user's chosen server so load failures on peer links don't wipe the session
  if (!primaryServerUrl) {
    try { primaryServerUrl = new URL(serverUrl).origin; } catch { primaryServerUrl = serverUrl; }
  }

  switchToServer(serverUrl);

  if (!mainWindow.isVisible()) {
    mainWindow.show();
    if (welcomeWindow) welcomeWindow.close();
  }
}

// ── Multi-Server View Management ────────────────────────────

function switchToServer(serverUrl) {
  // Strip to origin to prevent double-path issues (e.g. user enters /app, then we append /app.html)
  let url;
  try { url = new URL(serverUrl).origin; } catch { url = serverUrl.replace(/\/+$/, ''); }
  if (!mainWindow) return;

  let view = serverViews.get(url);
  if (!view) {
    view = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, 'app-preload.js'),
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
      },
    });
    mainWindow.addBrowserView(view);
    const [w, h] = mainWindow.getContentSize();
    view.setBounds({ x: 0, y: 0, width: w, height: h });
    view.setAutoResize({ width: true, height: true });

    view.webContents.loadURL(url + '/app.html');

    // ── Page load timeout — if no content after 15 s, offer to go back ──
    let loadResolved = false;
    view.webContents.once('did-finish-load', () => { loadResolved = true; });
    setTimeout(() => {
      if (loadResolved || !mainWindow) return;
      // Check if the page actually has content
      view.webContents.executeJavaScript('document.body?.innerText?.length || 0').then((len) => {
        if (len > 20) return; // Page has content, it's fine
        const choice = dialog.showMessageBoxSync(mainWindow, {
          type: 'warning',
          buttons: ['Go Back to Welcome', 'Keep Waiting'],
          defaultId: 0,
          title: 'Connection Problem',
          message: `Haven couldn't load the server at ${url}.\n\nThis could mean the server is down, the address is wrong, or there's a network issue.`,
        });
        if (choice === 0) resetToWelcome();
      }).catch(() => {});
    }, 15000);

    // ── Handle load failures — only reset to welcome for the primary server ──
    view.webContents.on('did-fail-load', (_e, errorCode, errorDesc) => {
      loadResolved = true;
      console.error(`[Haven Desktop] Failed to load ${url}: ${errorCode} ${errorDesc}`);
      if (url !== primaryServerUrl) {
        // A peer/secondary server failed — clean up and return to the primary view silently
        mainWindow?.removeBrowserView(view);
        try { view.webContents.destroy(); } catch {}
        serverViews.delete(url);
        if (primaryServerUrl && serverViews.has(primaryServerUrl)) {
          switchToServer(primaryServerUrl);
          const wc = serverViews.get(primaryServerUrl)?.webContents;
          if (wc && !wc.isDestroyed()) {
            wc.executeJavaScript(`
              if (typeof app !== 'undefined' && typeof app._showToast === 'function') {
                app._showToast("Couldn't connect to that server", 'error');
              }
            `).catch(() => {});
          }
        } else {
          resetToWelcome();
        }
        return;
      }
      resetToWelcome();
    });

    // ── Open external links in default browser (issue #5) ──
    view.webContents.on('will-navigate', (event, navUrl) => {
      try {
        if (new URL(navUrl).origin !== new URL(url).origin) {
          event.preventDefault();
          shell.openExternal(navUrl);
        }
      } catch {}
    });

    // Intercept window.open → switch servers or open external
    view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      handleWindowOpen(openUrl);
      return { action: 'deny' };
    });

    // Only open DevTools for the first server view in dev mode
    if (IS_DEV && serverViews.size === 0) view.webContents.openDevTools({ mode: 'detach' });
    serverViews.set(url, view);
  }

  mainWindow.setTopBrowserView(view);
  activeServerUrl = url;
}

function handleWindowOpen(url) {
  try {
    const parsed = new URL(url);
    if (/^https?:$/.test(parsed.protocol)) {
      // Only switch within the app for servers already registered in this session.
      // Unknown external URLs (including friends' Haven servers) open in the system
      // browser — trying to auto-load them risks a failed navigation that resets the session.
      if (serverViews.has(parsed.origin)) {
        switchToServer(parsed.origin);
        return;
      }
    }
  } catch { /* not a URL */ }
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
}

function getActiveContents() {
  if (activeServerUrl && serverViews.has(activeServerUrl))
    return serverViews.get(activeServerUrl).webContents;
  return mainWindow?.webContents || welcomeWindow?.webContents || null;
}

// ── Notification Badge ───────────────────────────────────────

function createBadgeIcon() {
  // 32×32 renders sharply on HiDPI Windows taskbars.
  // Shape: pointy-top hexagon matching Haven's app icon.
  // Fill: diagonal gradient #8b6ff0 → #6b4fdb (same as the SVG brand mark).
  // Ring: 2px light-lavender edge echoing the hex outline stroke.
  // Mark: white "!" so it reads clearly as a notification badge.
  const s = 32;
  const buf = Buffer.alloc(s * s * 4, 0);
  const cx = s / 2 - 0.5, cy = s / 2 - 0.5;  // sub-pixel center
  const R     = 14.5;  // outer circumradius
  const fillR = R - 2; // inner fill radius (= ring width of 2px)

  // Pointy-top hex: first vertex at top (image coords with y-down axis).
  // Angles: π/2, π/2+π/3, π/2+2π/3, …
  const uv = Array.from({ length: 6 }, (_, k) => {
    const a = Math.PI / 2 + k * Math.PI / 3;
    return [Math.cos(a), -Math.sin(a)]; // y-down: negate sin
  });

  // CW point-in-regular-hexagon test (cross product, all edges must have cross ≤ 0).
  function inHex(px, py, r) {
    const x = px - cx, y = py - cy;
    for (let k = 0; k < 6; k++) {
      const ax = uv[k][0] * r,       ay = uv[k][1] * r;
      const bx = uv[(k + 1) % 6][0] * r, by = uv[(k + 1) % 6][1] * r;
      if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) > 0) return false;
    }
    return true;
  }

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const px = x + 0.5, py = y + 0.5; // test pixel centre
      if (!inHex(px, py, R)) continue;  // transparent outside hex

      const i = (y * s + x) * 4;
      if (!inHex(px, py, fillR)) {
        // Ring: soft lavender-white, echoes the hex outline in the app icon
        buf[i] = 220; buf[i + 1] = 210; buf[i + 2] = 248; buf[i + 3] = 255;
      } else {
        // Gradient fill: #8b6ff0 (top-left) → #6b4fdb (bottom-right)
        const t = Math.max(0, Math.min(1, ((px - cx) + (py - cy)) / (fillR * 2) + 0.5));
        buf[i]     = Math.round(0x8b + t * (0x6b - 0x8b)); // 139 → 107
        buf[i + 1] = Math.round(0x6f + t * (0x4f - 0x6f)); // 111 →  79
        buf[i + 2] = Math.round(0xf0 + t * (0xdb - 0xf0)); // 240 → 219
        buf[i + 3] = 255;
      }
    }
  }

  // White "!" centered at x=15.5 (4px wide: px 14–17).
  // Bar: y 8–17 (10px).  Gap: y 18–21.  Dot: y 22–24 (3px).
  const paint = (px, py) => {
    if (px < 0 || px >= s || py < 0 || py >= s) return;
    const idx = (py * s + px) * 4;
    if (buf[idx + 3] === 0) return; // don't bleed outside hex
    buf[idx] = buf[idx + 1] = buf[idx + 2] = 255; buf[idx + 3] = 255;
  };
  for (let py = 8;  py <= 17; py++) for (let px = 14; px <= 17; px++) paint(px, py);
  for (let py = 22; py <= 24; py++) for (let px = 14; px <= 17; px++) paint(px, py);

  return nativeImage.createFromBuffer(buf, { width: s, height: s });
}

function setNotificationBadge() {
  if (!mainWindow) return;
  // Overlay/dock badge: always show when there are unreads (even if window is focused —
  // the user may be in a different channel and hasn't seen the new message yet).
  if (process.platform === 'win32' && badgeIcon) mainWindow.setOverlayIcon(badgeIcon, 'New messages');
  if (process.platform === 'darwin' || process.platform === 'linux') app.setBadgeCount(1);
  // Taskbar flash: only when the window is not already in focus (avoids annoying flicker).
  if (!mainWindow.isFocused()) mainWindow.flashFrame(true);
}

function clearNotificationBadge() {
  if (!mainWindow) return;
  if (process.platform === 'win32') mainWindow.setOverlayIcon(null, '');
  if (process.platform === 'darwin' || process.platform === 'linux') app.setBadgeCount(0);
  mainWindow.flashFrame(false);
}

// ═══════════════════════════════════════════════════════════
// System Tray
// ═══════════════════════════════════════════════════════════

function createTray() {
  let icon;
  try {
    const raw = nativeImage.createFromPath(ICON_PATH);
    // DPI-aware tray icon sizing (issue #4)
    const sf = screen.getPrimaryDisplay().scaleFactor || 1;
    if (process.platform === 'win32') {
      const s = Math.round(16 * sf);
      icon = raw.resize({ width: s, height: s });
    } else if (process.platform === 'linux') {
      const s = Math.round(24 * sf);
      icon = raw.resize({ width: s, height: s });
    } else {
      icon = raw.resize({ width: 22, height: 22 }); // macOS template size
    }
  } catch {
    return; // icon asset may not exist yet in dev
  }

  tray = new Tray(icon);
  tray.setToolTip('Haven Desktop');

  const rebuildMenu = () => {
    const running = serverManager?.isRunning();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Haven', click: () => { (mainWindow || welcomeWindow)?.show(); (mainWindow || welcomeWindow)?.focus(); } },
      { type: 'separator' },
      { label: running ? '● Server Running' : '○ Server Stopped', enabled: false },
      { type: 'separator' },
      { label: 'Quit Haven', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
  };

  rebuildMenu();
  // Refresh tray menu periodically so server status stays current
  setInterval(rebuildMenu, 10000);

  tray.on('click', () => {
    const win = mainWindow || welcomeWindow;
    if (win) { win.isVisible() ? win.focus() : win.show(); }
  });
}

// ═══════════════════════════════════════════════════════════
// Screen-Share Handler  (per-app audio magic)
// ═══════════════════════════════════════════════════════════
//
// When the Haven web app calls navigator.mediaDevices.getDisplayMedia(),
// Electron's handler fires.  We send the available sources + audio apps
// to the renderer, show a custom picker, and start native per-app audio
// capture for the selected application.
// ───────────────────────────────────────────────────────────

function registerScreenShareHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      // Video sources
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });

      // Audio-producing applications (native addon)
      let audioApps = [];
      try { audioApps = audioCapture.getAudioApplications(); }
      catch (err) { console.warn('[ScreenShare] audio app enumeration failed:', err.message); }

      const sourceData = sources.map(s => ({
        id:         s.id,
        name:       s.name,
        thumbnail:  s.thumbnail.toDataURL(),
        appIcon:    s.appIcon ? s.appIcon.toDataURL() : null,
        display_id: s.display_id,
      }));

      const targetContents = getActiveContents();
      if (!targetContents) { callback({}); return; }

      // Ask renderer to show the picker
      targetContents.send('screen:show-picker', { sources: sourceData, audioApps });

      // Wait for picker result (or 60 s timeout)
      const result = await new Promise(resolve => {
        const handler = (_e, res) => resolve(res);
        ipcMain.once('screen:picker-result', handler);
        setTimeout(() => { ipcMain.removeListener('screen:picker-result', handler); resolve({ cancelled: true }); }, 60000);
      });

      if (result.cancelled) { callback({}); return; }

      const selected = sources.find(s => s.id === result.sourceId);
      if (!selected) { callback({}); return; }

      // Start per-app audio capture when a specific app was chosen
      let usePerAppAudio = false;
      if (result.audioAppPid && result.audioAppPid > 0) {
        try {
          audioCapture.startCapture(result.audioAppPid, (pcmData) => {
            if (targetContents && !targetContents.isDestroyed()) {
              targetContents.send('audio:capture-data', pcmData);
            }
          });
          usePerAppAudio = true;
        } catch (err) {
          console.error('[ScreenShare] per-app audio start failed:', err.message);
        }
      }

      // Per-app audio: stream from native addon only (no loopback).
      // No audio: user explicitly chose silence.
      // System audio: use loopback (default).
      if (usePerAppAudio) {
        callback({ video: selected });
      } else if (result.audioAppPid === 'none') {
        callback({ video: selected });
      } else {
        callback({ video: selected, audio: 'loopback' });
      }

    } catch (err) {
      console.error('[ScreenShare] handler error:', err);
      callback({});
    }
  });
}

// ═══════════════════════════════════════════════════════════
// IPC Handlers
// ═══════════════════════════════════════════════════════════

function registerIPC() {

  // ── Server Management ─────────────────────────────────
  ipcMain.handle('server:detect',      ()        => serverManager.detectServer());
  ipcMain.handle('server:start',       (_e, dir) => serverManager.startServer(dir));
  ipcMain.handle('server:stop',        ()        => serverManager.stopServer());
  ipcMain.handle('server:status',      ()        => serverManager.getStatus());

  ipcMain.handle('server:browse', async () => {
    const r = await dialog.showOpenDialog(welcomeWindow || mainWindow, {
      title: 'Select Haven Server Directory',
      properties: ['openDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('server:browse-file', async () => {
    const r = await dialog.showOpenDialog(welcomeWindow || mainWindow, {
      title: 'Select server.js',
      properties: ['openFile'],
      filters: [{ name: 'JavaScript', extensions: ['js'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ── Auto-Update ───────────────────────────────────────
  ipcMain.handle('update:download', async () => {
    if (!autoUpdater) return { error: 'Auto-updater not available' };
    try { await autoUpdater.downloadUpdate(); return { success: true }; }
    catch (err) { return { error: err.message }; }
  });
  ipcMain.on('update:install', () => {
    if (autoUpdater) {
      serverManager?.stopServer();
      autoUpdater.quitAndInstall(false, true);
    }
  });

  // ── Audio Capture ─────────────────────────────────────
  ipcMain.handle('audio:get-apps',      () => { try { return audioCapture.getAudioApplications(); } catch { return []; } });
  ipcMain.handle('audio:start-capture',  (_e, pid) => audioCapture.startCapture(pid, pcm => {
    const wc = getActiveContents();
    if (wc && !wc.isDestroyed()) wc.send('audio:capture-data', pcm);
  }));
  ipcMain.handle('audio:stop-capture',   () => audioCapture.stopCapture());
  ipcMain.handle('audio:is-supported',   () => audioCapture.isSupported());

  // ── Audio Devices ─────────────────────────────────────
  ipcMain.handle('devices:get-inputs', async () => {
    const wc = getActiveContents();
    if (!wc) return [];
    return wc.executeJavaScript(`
      navigator.mediaDevices.enumerateDevices()
        .then(d => d.filter(x => x.kind==='audioinput').map(x => ({ deviceId:x.deviceId, label:x.label||'Mic '+x.deviceId.slice(0,8), groupId:x.groupId })))
    `);
  });

  ipcMain.handle('devices:get-outputs', async () => {
    const wc = getActiveContents();
    if (!wc) return [];
    return wc.executeJavaScript(`
      navigator.mediaDevices.enumerateDevices()
        .then(d => d.filter(x => x.kind==='audiooutput').map(x => ({ deviceId:x.deviceId, label:x.label||'Speaker '+x.deviceId.slice(0,8), groupId:x.groupId })))
    `);
  });

  // ── Notifications ─────────────────────────────────────
  ipcMain.handle('notify', (_e, opts) => {
    const n = new Notification({
      title: opts.title || 'Haven',
      body:  opts.body  || '',
      icon:  ICON_PATH,
      silent: opts.silent || false,
    });
    n.show();
    n.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });

    // Set badge whenever a native notification fires; setNotificationBadge()
    // now handles isFocused internally for flashFrame only.
    if (mainWindow) setNotificationBadge();
    return true;
  });

  // ── Unread badge signal (fired by renderer on any unread count change) ──
  // Works even when native push notifications are unavailable (VPN/LAN setups).
  // No isFocused() guard here — the overlay should reflect real unread state
  // regardless of whether the window is currently focused. The renderer fires
  // hasUnread=false only once all channels are actually read.
  ipcMain.on('notification-badge', (_e, hasUnread) => {
    if (hasUnread) setNotificationBadge();
    else clearNotificationBadge();
  });

  // ── Window Controls ───────────────────────────────────
  ipcMain.on('window:minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
  ipcMain.on('window:maximize', () => {
    const w = BrowserWindow.getFocusedWindow();
    w?.isMaximized() ? w.unmaximize() : w?.maximize();
  });
  ipcMain.on('window:close', () => BrowserWindow.getFocusedWindow()?.close());

  // ── Settings ──────────────────────────────────────────
  const ALLOWED_SETTINGS_KEYS = new Set([
    'userPrefs', 'windowBounds', 'audioInputDevice', 'audioOutputDevice',
    'lastServer', 'pushToTalk', 'pushToTalkKey', 'noiseGate', 'noiseThreshold'
  ]);
  ipcMain.handle('settings:get', (_e, key)        => store.get(key));
  ipcMain.handle('settings:set', (_e, key, value)  => {
    if (!ALLOWED_SETTINGS_KEYS.has(key)) return false;
    store.set(key, value);
    return true;
  });

  // ── App Info ──────────────────────────────────────────
  ipcMain.handle('app:version', () => app.getVersion());

  // ── Navigation ────────────────────────────────────────
  ipcMain.on('nav:open-app', (_e, serverUrl) => createAppWindow(serverUrl));
  ipcMain.on('nav:back-to-welcome', () => resetToWelcome());
  ipcMain.on('nav:switch-server', (_e, serverUrl) => {
    if (mainWindow && typeof serverUrl === 'string' && /^https?:\/\//i.test(serverUrl)) {
      try { switchToServer(new URL(serverUrl).origin); } catch {}
    }
  });

  // ── External links ────────────────────────────────────
  ipcMain.on('open-external', (_e, url) => {
    // Only allow http/https URLs to prevent file:// or protocol handler abuse
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });

  // ── JavaScript dialog overrides for BrowserView (issue #6) ──

  ipcMain.on('dialog:alert', (event, { message }) => {
    dialog.showMessageBoxSync(mainWindow, {
      type: 'info', buttons: ['OK'], title: 'Haven',
      message: String(message || ''),
    });
    event.returnValue = true;
  });

  ipcMain.on('dialog:confirm', (event, { message }) => {
    const r = dialog.showMessageBoxSync(mainWindow, {
      type: 'question', buttons: ['Cancel', 'OK'],
      defaultId: 1, cancelId: 0, title: 'Haven',
      message: String(message || ''),
    });
    event.returnValue = r === 1;
  });

  ipcMain.on('dialog:prompt', (event, { message, defaultValue }) => {
    // BrowserView doesn't natively support window.prompt().
    // Use OS-native dialogs via child_process for a synchronous result.
    const { execSync } = require('child_process');
    try {
      if (process.platform === 'win32') {
        // VBScript InputBox can distinguish Cancel (Empty) from OK-with-empty-string.
        const esc = (s) => String(s || '').replace(/"/g, '""');
        const tmpVbs = path.join(os.tmpdir(), `haven-prompt-${Date.now()}.vbs`);
        const vbs = [
          `Dim r`,
          `r = InputBox("${esc(message)}", "Haven", "${esc(defaultValue)}")`,
          `If IsEmpty(r) Then`,
          `  WScript.Quit 1`,
          `Else`,
          `  WScript.StdOut.Write r`,
          `  WScript.Quit 0`,
          `End If`,
        ].join('\r\n');
        fs.writeFileSync(tmpVbs, vbs);
        try {
          const result = execSync(`cscript //Nologo "${tmpVbs}"`, {
            encoding: 'utf-8', timeout: 300000,
          });
          try { fs.unlinkSync(tmpVbs); } catch {}
          event.returnValue = result;
        } catch {
          try { fs.unlinkSync(tmpVbs); } catch {}
          event.returnValue = null; // Cancel pressed
        }
      } else {
        // Linux: zenity (exit 1 = cancel, exit 0 = OK)
        const esc = (s) => String(s || '').replace(/"/g, '\\"');
        const result = execSync(
          `zenity --entry --title="Haven" --text="${esc(message)}" --entry-text="${esc(defaultValue)}" 2>/dev/null`,
          { encoding: 'utf-8', timeout: 300000 }
        ).replace(/\r?\n$/, '');
        event.returnValue = result;
      }
    } catch {
      event.returnValue = null;
    }
  });
}

// ═══════════════════════════════════════════════════════════
// Linux Desktop Integration (issue #3)
//
// When running as an AppImage, install a .desktop entry and
// icon so Haven appears in the application launcher.
// ═══════════════════════════════════════════════════════════

function installLinuxDesktopEntry() {
  const appImagePath = process.env.APPIMAGE;
  if (!appImagePath) return; // Only for AppImage installs

  const home = process.env.HOME || os.homedir();
  const appsDir = path.join(home, '.local', 'share', 'applications');
  const iconDir = path.join(home, '.local', 'share', 'icons');
  const desktopFile = path.join(appsDir, 'haven-desktop.desktop');
  const iconDest = path.join(iconDir, 'haven-desktop.png');

  // Skip if already registered for this AppImage path
  if (fs.existsSync(desktopFile)) {
    try {
      if (fs.readFileSync(desktopFile, 'utf-8').includes(appImagePath)) return;
    } catch {}
  }

  try {
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(iconDir, { recursive: true });

    if (fs.existsSync(ICON_PATH)) fs.copyFileSync(ICON_PATH, iconDest);

    const entry = [
      '[Desktop Entry]',
      'Name=Haven',
      'Comment=Private self-hosted chat',
      `Exec="${appImagePath}" %U`,
      `Icon=${iconDest}`,
      'Type=Application',
      'Categories=Network;Chat;InstantMessaging;',
      'Terminal=false',
      'StartupWMClass=haven',
    ].join('\n');

    fs.writeFileSync(desktopFile, entry);
    try { require('child_process').execSync(`update-desktop-database "${appsDir}" 2>/dev/null`, { timeout: 5000 }); } catch {}
    console.log('[Haven Desktop] Installed desktop entry:', desktopFile);
  } catch (err) {
    console.warn('[Haven Desktop] Desktop integration failed:', err.message);
  }
}

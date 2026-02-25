// ═══════════════════════════════════════════════════════════
// Haven Desktop — Main Process
// ═══════════════════════════════════════════════════════════

const {
  app, BrowserWindow, BrowserView, ipcMain, Notification, Tray, Menu,
  nativeImage, desktopCapturer, session, dialog, shell
} = require('electron');
const path  = require('path');
const fs    = require('fs');
const Store = require('electron-store');
const { ServerManager }      = require('./server-manager');
const { AudioCaptureManager } = require('./audio-capture');

// ── Constants ─────────────────────────────────────────────
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
  try {
    const parsed = new URL(url);
    const host   = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      event.preventDefault();
      callback(true);  // accept the self-signed cert
      return;
    }
  } catch { /* fall through */ }
  callback(false);  // reject for non-local hosts
});

// ═══════════════════════════════════════════════════════════
// App Lifecycle
// ═══════════════════════════════════════════════════════════

app.whenReady().then(async () => {
  serverManager = new ServerManager(store, { showConsole: SHOW_SERVER || IS_DEV });
  audioCapture  = new AudioCaptureManager();
  badgeIcon     = createBadgeIcon();

  // Forward server log lines to whichever renderer window is active
  serverManager.onLog((msg) => {
    const wc = getActiveContents() || welcomeWindow?.webContents;
    if (wc && !wc.isDestroyed()) wc.send('server:log', msg);
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
});

app.on('window-all-closed', () => {
  // Quit the app when all windows are closed
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
    mainWindow.on('focus',  clearNotificationBadge);
    mainWindow.on('closed', () => {
      serverViews.clear();
      activeServerUrl = null;
      mainWindow = null;
    });
  }

  switchToServer(serverUrl);

  if (!mainWindow.isVisible()) {
    mainWindow.show();
    if (welcomeWindow) welcomeWindow.close();
  }
}

// ── Multi-Server View Management ────────────────────────────

function switchToServer(serverUrl) {
  const url = serverUrl.replace(/\/+$/, '');
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

    // Intercept window.open → switch servers or open external
    view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      handleWindowOpen(openUrl);
      return { action: 'deny' };
    });

    if (IS_DEV) view.webContents.openDevTools({ mode: 'detach' });
    serverViews.set(url, view);
  }

  mainWindow.setTopBrowserView(view);
  activeServerUrl = url;
}

function handleWindowOpen(url) {
  try {
    const parsed = new URL(url);
    if (/^https?:$/.test(parsed.protocol)) {
      switchToServer(parsed.origin);
      return;
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
  const s = 16, buf = Buffer.alloc(s * s * 4, 0);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = x - s / 2, dy = y - s / 2;
      if (Math.sqrt(dx * dx + dy * dy) < s / 2 - 0.5) {
        const i = (y * s + x) * 4;
        // Haven purple #6b4fdb
        buf[i] = 107; buf[i + 1] = 79; buf[i + 2] = 219; buf[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: s, height: s });
}

function setNotificationBadge() {
  if (!mainWindow) return;
  if (process.platform === 'win32' && badgeIcon) mainWindow.setOverlayIcon(badgeIcon, 'New messages');
  mainWindow.flashFrame(true);
}

function clearNotificationBadge() {
  if (!mainWindow) return;
  if (process.platform === 'win32') mainWindow.setOverlayIcon(null, '');
  mainWindow.flashFrame(false);
}

// ═══════════════════════════════════════════════════════════
// System Tray
// ═══════════════════════════════════════════════════════════

function createTray() {
  let icon;
  try {
    icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
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

      // When per-app audio is active, do NOT pass system loopback —
      // the per-app track from the native addon is the only audio source.
      // This prevents all system audio from leaking through.
      if (usePerAppAudio) {
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

    // Taskbar notification badge when window is not focused
    if (mainWindow && !mainWindow.isFocused()) setNotificationBadge();
    return true;
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
  ipcMain.on('nav:back-to-welcome', () => { mainWindow?.close(); createWelcomeWindow(); });

  // ── External links ────────────────────────────────────
  ipcMain.on('open-external', (_e, url) => {
    // Only allow http/https URLs to prevent file:// or protocol handler abuse
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });
}

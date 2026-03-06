# Haven Desktop Changelog

## v1.1.0

### Bug Fixes
- **SSL error flood causing blank screen + OOM crash** — when connecting to a Haven server over HTTPS with a self-signed certificate, the existing `certificate-error` handler only covered page navigation. WebSocket reconnection attempts (Socket.IO) and fetch/XHR requests still hit Chromium's native `ssl_client_socket_impl` layer, which rejected the cert and logged an error object for every single failed handshake. During reconnection storms, thousands of these errors accumulated in the renderer's heap until Oilpan's garbage collector couldn't allocate, causing a fatal OOM crash and a blank screen. Fix: `setCertificateVerifyProc` on the default session now accepts all certificates at the session level, which covers *all* connection types (navigation, WebSocket, fetch, XHR) before the C++ TLS code ever sees a failure. The SSL error flood no longer occurs, so the renderer never OOMs.
- **Infinite crash-reload loop** — the v1.0.9 `render-process-gone` handler would reload the page unconditionally on every crash, creating an infinite crash → reload → crash cycle if the underlying cause persisted. Crash recovery now has a retry limit of 3 with exponential back-off (1.5 s → 3 s → 6 s), and resets the counter after 60 seconds of stability.

---

## v1.0.9

### Added
- **Global voice keyboard shortcuts** — mute, deafen, and push-to-talk can now be assigned to system-wide hotkeys in Settings → Keyboard Shortcuts. Shortcuts work even when Haven Desktop isn't the focused window.

### Bug Fixes
- **Blank app window** — the renderer window could go completely blank during server restarts, reconnects, or rapid view transitions. Root cause: `webContents.send()` fires through Electron's native C++ IPC layer *before* throwing a catchable JS exception, so a simple `try/catch` isn't enough — the native send to a disposed render frame still corrupts the renderer's IPC channel. Fix:
  1. A new `safeSend()` helper checks `wc.mainFrame` (which returns `undefined` when the frame is disposed) *before* calling `send()`, preventing the native code from ever attempting the IPC send.
  2. Server log forwarding is now batched to 50 ms intervals instead of firing synchronously for every line of stdout — this eliminates the rapid-fire IPC bursts during startup/reconnect.
  3. A `render-process-gone` crash-recovery handler on each BrowserView automatically reloads the page if the renderer dies for any reason, so the screen can never stay permanently blank.

---

## v1.0.8

### Bug Fixes
- **Auto-launch no longer broken after server load failure** — a bug introduced in v1.0.7 (alongside the FCM/installer update) caused the app to forget your saved server on any load failure or startup hiccup, permanently dropping you back to the welcome screen on every subsequent launch. The fix: your server preferences (path, URL, mode) are now preserved across failures so the next launch retries automatically. Use Ctrl+Shift+Home to intentionally reset and return to the welcome screen.

---

## v1.0.7

### Bug Fixes
- **Taskbar badge now reliably appears for unread messages** — three bugs were causing the overlay badge to fail or behave erratically: (1) a `focus` event cleared the badge immediately whenever the window was focused, even with unreads remaining; (2) an `isFocused()` guard on the IPC handler blocked the badge from being set while the app was open but you were in a different channel; (3) `flashFrame` was firing unconditionally, causing taskbar flicker even when the window was already in focus. All three are fixed.

### Improvements
- **Haven-branded notification badge** — the overlay icon is now a Haven hexagon with the app's signature purple gradient and a "!" mark, instead of a plain fuchsia circle.

---

## v1.0.6

### Improvements
- **Screen share picker — audio/cancel/share always visible** — the Application Audio selection and Cancel/Share buttons are now pinned outside the scrollable area. Only the screen and window list scrolls, so you never need to scroll down to find the buttons.
- **"No Audio" option added to screen share picker** — a new 🔇 No Audio button lets you share your screen with no audio at all. The existing System Audio option now correctly shows a 🔊 speaker icon instead of the muted speaker.

### Bug Fixes
- **Ghost voice-chat state on app restart** — closing the app while in a voice channel no longer causes the app to "think" you’re still in voice on the next launch (blocking you from joining again). The saved voice channel is now cleared on each fresh page load; auto-rejoin on network blips within the same session is unaffected.

---

## v1.0.5

### Bug Fixes
- **Windows volume ducking** — The desktop app no longer causes Windows to lower its own volume (or other apps') in the volume mixer when voice activity is detected. The audio capture stream is now categorized as `AudioCategory_Other`, opting out of Windows' automatic communications ducking behavior.

---

## v1.0.4

### New Features
- **Auto-update system** — When a new version is available, a banner appears at the bottom of the screen. Click "Download" to fetch the update, then "Restart & Install" to apply it. No manual downloads needed.

### Bug Fixes
- **Tray icon now shows correctly** in packaged builds (assets were not being bundled).
- **Soft-lock recovery** — If the app gets stuck on a blank screen (e.g. saved server became unreachable), press **Ctrl+Shift+Home** to reset back to the welcome screen. A 15-second page-load timeout also offers to take you back automatically.
- **Wayland screen-share picker** — Improved dismiss behavior: background overlay click, better ESC handling, and focus restoration after closing the picker.

---

## v1.0.3

- Initial public release.

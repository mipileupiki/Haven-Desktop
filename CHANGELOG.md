# Haven Desktop Changelog

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

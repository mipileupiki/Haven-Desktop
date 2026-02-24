// ═══════════════════════════════════════════════════════════
// Haven Desktop — Audio Capture Manager
//
// Provides per-application audio capture via native addons:
//   • Windows  →  WASAPI Process Loopback (Win 10 2004+)
//   • Linux    →  PulseAudio sink-input isolation
//
// The native addon (native/build/Release/haven_audio.node) is
// compiled from C++ during `npm run build:native`.  If it is
// missing, all methods degrade gracefully (no crash, no audio).
// ═══════════════════════════════════════════════════════════

const path = require('path');

class AudioCaptureManager {
  constructor() {
    this._addon    = null;
    this._capturing = false;
    this._callback  = null;
    this._loadAddon();
  }

  // ── Load the compiled native module ─────────────────────
  _loadAddon() {
    const searchPaths = [
      path.join(__dirname, '..', '..', 'native', 'build', 'Release', 'haven_audio.node'),
      path.join(__dirname, '..', '..', 'native', 'build', 'Debug',   'haven_audio.node'),
    ];

    // When running from a packaged app, resources live in a different place
    if (process.resourcesPath) {
      searchPaths.push(path.join(process.resourcesPath, 'native', 'haven_audio.node'));
    }

    for (const p of searchPaths) {
      try {
        this._addon = require(p);
        console.log(`[AudioCapture] Native addon loaded: ${p}`);
        return;
      } catch { /* try next */ }
    }

    console.warn('[AudioCapture] Native addon not found — per-app audio unavailable.');
    console.warn('[AudioCapture] Run  npm run build:native  to compile it.');
  }

  // ── Public API ──────────────────────────────────────────

  /** Is per-app capture supported on this OS? */
  isSupported() {
    if (!this._addon) return false;
    try { return this._addon.isSupported(); }
    catch { return false; }
  }

  /**
   * List applications currently producing audio.
   * @returns {Array<{pid:number, name:string, icon?:string}>}
   */
  getAudioApplications() {
    if (!this._addon) return [];
    try { return this._addon.getAudioApplications(); }
    catch (e) { console.error('[AudioCapture] getAudioApplications:', e); return []; }
  }

  /**
   * Start capturing audio from a specific PID.
   * @param {number} pid  Process ID to capture
   * @param {function} cb  Receives Float32Array PCM chunks (48 kHz mono)
   */
  startCapture(pid, cb) {
    if (!this._addon) throw new Error('Native audio capture addon not available');
    if (this._capturing) this.stopCapture();

    this._callback  = cb;
    this._capturing = true;

    try {
      this._addon.startCapture(pid, (pcm) => { if (this._callback) this._callback(pcm); });
      console.log(`[AudioCapture] Capturing PID ${pid}`);
      return true;
    } catch (e) {
      this._capturing = false;
      this._callback  = null;
      throw e;
    }
  }

  /** Stop active capture. */
  stopCapture() {
    if (this._addon && this._capturing) {
      try { this._addon.stopCapture(); } catch { /* */ }
    }
    this._capturing = false;
    this._callback  = null;
  }

  /** Release all resources. */
  cleanup() {
    this.stopCapture();
    if (this._addon?.cleanup) { try { this._addon.cleanup(); } catch { /* */ } }
  }
}

module.exports = { AudioCaptureManager };

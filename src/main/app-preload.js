// ═══════════════════════════════════════════════════════════
// Haven Desktop — App Window Preload
//
// Loaded when the Haven web app runs inside the desktop shell.
// Provides:
//  • Per-application audio capture during screen share
//  • Custom screen-share picker (windows + audio apps)
//  • Native desktop notifications
//  • Audio device enumeration & hot-switching
//  • Transparent getDisplayMedia() override (Haven's voice.js
//    calls the same API — our code intercepts and enhances it)
// ═══════════════════════════════════════════════════════════

const { ipcRenderer } = require('electron');

// ─── Internal state ──────────────────────────────────────
let _audioWorkletNode    = null;
let _audioCtx            = null;
let _audioDestination    = null;
let _audioBufferQueue    = [];
let _capturedAudioPid    = null;

// ─── Receive PCM chunks from native addon (main process) ─
ipcRenderer.on('audio:capture-data', (_event, pcmData) => {
  const samples = new Float32Array(
    pcmData.buffer  ? pcmData.buffer
    : ArrayBuffer.isView(pcmData) ? pcmData.buffer
    : pcmData
  );

  if (_audioWorkletNode) {
    _audioWorkletNode.port.postMessage({ type: 'audio-data', samples });
  } else {
    _audioBufferQueue.push(samples);
  }
});

// ─── Listen for screen-picker request from main process ──
ipcRenderer.on('screen:show-picker', (_event, data) => {
  showScreenPicker(data.sources, data.audioApps);
});

// ═══════════════════════════════════════════════════════════
// Screen-Share Picker  (injected as a full-screen overlay)
// ═══════════════════════════════════════════════════════════

function showScreenPicker(sources, audioApps) {
  // Remove stale picker
  document.getElementById('haven-screen-picker')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'haven-screen-picker';
  overlay.innerHTML = `
    <style>
      #haven-screen-picker {
        position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:999999;
        display:flex;align-items:center;justify-content:center;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      }
      .hsp-box{background:#1a1a2e;border-radius:14px;padding:28px;max-width:820px;width:92%;
        max-height:82vh;overflow-y:auto;border:1px solid rgba(107,79,219,.3);
        box-shadow:0 20px 60px rgba(0,0,0,.5);}
      .hsp-title{color:#e0e0e0;font-size:20px;font-weight:700;margin-bottom:2px}
      .hsp-sub{color:#888;font-size:13px;margin-bottom:18px}
      .hsp-sec{margin-bottom:14px}
      .hsp-sec-title{color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;
        margin-bottom:8px;font-weight:700}
      .hsp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:10px}
      .hsp-src{background:#16213e;border-radius:8px;padding:8px;cursor:pointer;
        border:2px solid transparent;transition:border-color .2s,transform .15s}
      .hsp-src:hover{border-color:rgba(107,79,219,.5);transform:translateY(-1px)}
      .hsp-src.sel{border-color:#6b4fdb}
      .hsp-src img{width:100%;border-radius:4px;margin-bottom:6px;aspect-ratio:16/9;
        object-fit:cover;background:#0d0d1a}
      .hsp-src-name{color:#ccc;font-size:12px;text-align:center;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis}
      .hsp-audio{margin-top:16px;padding-top:16px;border-top:1px solid #2a2a4a}
      .hsp-apps{display:flex;flex-wrap:wrap;gap:8px}
      .hsp-app{background:#16213e;border-radius:6px;padding:8px 14px;cursor:pointer;
        border:2px solid transparent;transition:border-color .2s;display:flex;
        align-items:center;gap:8px;color:#ccc;font-size:13px}
      .hsp-app:hover{border-color:rgba(107,79,219,.5)}
      .hsp-app.sel{border-color:#6b4fdb}
      .hsp-app .ico{width:20px;height:20px}
      .hsp-btns{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}
      .hsp-btn{padding:8px 22px;border-radius:6px;border:none;font-size:14px;cursor:pointer;font-weight:600}
      .hsp-cancel{background:#333;color:#ccc}.hsp-cancel:hover{background:#444}
      .hsp-share{background:#6b4fdb;color:#fff}.hsp-share:hover{background:#7b5fe9}
      .hsp-share:disabled{opacity:.45;cursor:not-allowed}
      .hsp-none{color:#666;font-size:12px;font-style:italic;padding:8px}
    </style>

    <div class="hsp-box">
      <div class="hsp-title">Share Your Screen</div>
      <div class="hsp-sub">Choose a window or screen — then optionally pick an application whose audio to share.</div>

      <div class="hsp-sec">
        <div class="hsp-sec-title">Screens</div>
        <div class="hsp-grid" id="hsp-screens"></div>
      </div>

      <div class="hsp-sec">
        <div class="hsp-sec-title">Application Windows</div>
        <div class="hsp-grid" id="hsp-windows"></div>
      </div>

      <div class="hsp-audio">
        <div class="hsp-sec-title">🔊 Application Audio — isolate audio from a specific app</div>
        <div class="hsp-apps" id="hsp-audio-apps"></div>
      </div>

      <div class="hsp-btns">
        <button class="hsp-btn hsp-cancel" id="hsp-cancel">Cancel</button>
        <button class="hsp-btn hsp-share"  id="hsp-go" disabled>Share</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  let selSource = null;
  let selAudioPid = null;

  const screensEl  = document.getElementById('hsp-screens');
  const windowsEl  = document.getElementById('hsp-windows');
  const appsEl     = document.getElementById('hsp-audio-apps');
  const goBtn      = document.getElementById('hsp-go');

  // ── Populate video sources ─────────────────────────────
  sources.forEach(src => {
    const el = document.createElement('div');
    el.className = 'hsp-src';
    el.innerHTML = `<img src="${src.thumbnail}" alt=""><div class="hsp-src-name" title="${src.name}">${src.name}</div>`;
    el.onclick = () => {
      overlay.querySelectorAll('.hsp-src.sel').forEach(s => s.classList.remove('sel'));
      el.classList.add('sel');
      selSource = src.id;
      goBtn.disabled = false;
    };
    (src.id.startsWith('screen:') ? screensEl : windowsEl).appendChild(el);
  });

  // ── Populate audio applications ────────────────────────
  if (audioApps && audioApps.length) {
    // "No App Audio" default
    const noEl = document.createElement('div');
    noEl.className = 'hsp-app sel';
    noEl.innerHTML = '🔇&nbsp; System Audio Only';
    noEl.onclick = () => {
      appsEl.querySelectorAll('.sel').forEach(a => a.classList.remove('sel'));
      noEl.classList.add('sel');
      selAudioPid = null;
    };
    appsEl.appendChild(noEl);

    audioApps.forEach(a => {
      const el = document.createElement('div');
      el.className = 'hsp-app';
      const icon = a.icon ? `<img class="ico" src="${a.icon}" alt="">` : '🔊';
      el.innerHTML = `${icon}<span>${a.name}</span>`;
      el.onclick = () => {
        appsEl.querySelectorAll('.sel').forEach(x => x.classList.remove('sel'));
        el.classList.add('sel');
        selAudioPid = a.pid;
      };
      appsEl.appendChild(el);
    });
  } else {
    appsEl.innerHTML = '<div class="hsp-none">Per-app audio capture is unavailable — system audio will be shared instead. Build the native module to enable this feature.</div>';
  }

  // ── Cancel ─────────────────────────────────────────────
  const dismiss = (cancelled) => {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
    ipcRenderer.send('screen:picker-result', cancelled ? { cancelled: true } : { sourceId: selSource, audioAppPid: selAudioPid });
    if (!cancelled && selAudioPid) {
      _capturedAudioPid = selAudioPid;
      buildAudioPipeline();
    }
  };

  document.getElementById('hsp-cancel').onclick = () => dismiss(true);
  goBtn.onclick = () => dismiss(false);

  const escHandler = (e) => { if (e.key === 'Escape') dismiss(true); };
  document.addEventListener('keydown', escHandler);
}

// ═══════════════════════════════════════════════════════════
// Audio-Capture Pipeline
//
// Receives PCM from the native addon via IPC, pipes it through
// an AudioWorklet, and exposes a MediaStreamTrack that replaces
// the system-loopback track on the screen-share MediaStream.
// ═══════════════════════════════════════════════════════════

async function buildAudioPipeline() {
  try {
    _audioCtx = new AudioContext({ sampleRate: 48000 });

    // Inline AudioWorklet processor (blob URL avoids CSP / file issues)
    const workletSrc = `
      class AppAudioProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this._ring   = new Float32Array(96000);   // 2 s ring buffer
          this._wPos   = 0;
          this._rPos   = 0;
          this._avail  = 0;

          this.port.onmessage = (e) => {
            if (e.data.type !== 'audio-data') return;
            const s = e.data.samples;
            for (let i = 0; i < s.length; i++) {
              this._ring[this._wPos] = s[i];
              this._wPos = (this._wPos + 1) % this._ring.length;
            }
            this._avail = Math.min(this._avail + s.length, this._ring.length);
          };
        }

        process(_inputs, outputs) {
          const out = outputs[0];
          if (!out || !out.length) return true;
          const buf = out[0];
          const len = buf.length;

          if (this._avail < len) { buf.fill(0); return true; }

          for (let i = 0; i < len; i++) {
            buf[i] = this._ring[this._rPos];
            this._rPos = (this._rPos + 1) % this._ring.length;
          }
          this._avail -= len;

          for (let ch = 1; ch < out.length; ch++) out[ch].set(buf);
          return true;
        }
      }
      registerProcessor('app-audio-processor', AppAudioProcessor);
    `;

    const blob = new Blob([workletSrc], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    await _audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    _audioWorkletNode = new AudioWorkletNode(_audioCtx, 'app-audio-processor', {
      outputChannelCount: [2],
    });

    _audioDestination = _audioCtx.createMediaStreamDestination();
    _audioWorkletNode.connect(_audioDestination);

    // Flush any PCM that arrived before the pipeline was ready
    _audioBufferQueue.forEach(buf =>
      _audioWorkletNode.port.postMessage({ type: 'audio-data', samples: buf })
    );
    _audioBufferQueue = [];

    // Expose track globally so our getDisplayMedia override can grab it
    window._havenAppAudioTrack  = _audioDestination.stream.getAudioTracks()[0];
    window._havenAppAudioStream = _audioDestination.stream;

    console.log('[Haven Desktop] Per-app audio pipeline active');
  } catch (err) {
    console.error('[Haven Desktop] Audio pipeline setup failed:', err);
  }
}

function teardownAudioPipeline() {
  _audioWorkletNode?.disconnect();
  _audioWorkletNode = null;
  _audioCtx?.close().catch(() => {});
  _audioCtx         = null;
  _audioDestination = null;
  _capturedAudioPid = null;
  _audioBufferQueue = [];
  window._havenAppAudioTrack  = null;
  window._havenAppAudioStream = null;
  ipcRenderer.invoke('audio:stop-capture').catch(() => {});
}

// ═══════════════════════════════════════════════════════════
// Override getDisplayMedia()
//
// After Electron's handler resolves with a video stream, we
// swap the system-loopback audio track for our per-app track.
// Haven's voice.js calls the same standard API — zero changes
// needed on the server/browser code.
//
// NOTE: navigator.mediaDevices is not available at preload
// time — it only exists once the renderer page has loaded.
// We defer the override until DOMContentLoaded.
// ═══════════════════════════════════════════════════════════

function installGetDisplayMediaOverride() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    // Not ready yet (rare, but possible) — retry briefly
    setTimeout(installGetDisplayMediaOverride, 100);
    return;
  }

  const _origGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getDisplayMedia = async function (constraints) {
    const stream = await _origGDM(constraints);

    // Replace audio track with our per-app capture if active
    if (window._havenAppAudioTrack) {
      stream.getAudioTracks().forEach(t => { stream.removeTrack(t); t.stop(); });
      stream.addTrack(window._havenAppAudioTrack);
      console.log('[Haven Desktop] Swapped system audio → per-app audio');
    }

    // Auto-teardown when the video track ends (user stops sharing)
    stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => teardownAudioPipeline()));

    return stream;
  };

  console.log('[Haven Desktop] getDisplayMedia override installed');
}

document.addEventListener('DOMContentLoaded', installGetDisplayMediaOverride);

// ═══════════════════════════════════════════════════════════
//  Desktop Notifications  (override browser Notification API)
// ═══════════════════════════════════════════════════════════

class HavenNotification {
  constructor(title, opts = {}) {
    ipcRenderer.invoke('notify', { title, body: opts.body || '', silent: opts.silent || false });
    this._onclick = null;
  }
  set onclick(fn) { this._onclick = fn; }
  get onclick()   { return this._onclick; }
  close() {}
  static get permission() { return 'granted'; }
  static requestPermission() { return Promise.resolve('granted'); }
}
window.Notification = HavenNotification;

// ═══════════════════════════════════════════════════════════
//  Exposed API  (window.havenDesktop)
// ═══════════════════════════════════════════════════════════

window.havenDesktop = {
  platform:     process.platform,
  isDesktopApp: true,

  audio: {
    getApplications: () => ipcRenderer.invoke('audio:get-apps'),
    startCapture:    (pid) => ipcRenderer.invoke('audio:start-capture', pid),
    stopCapture:     ()    => { teardownAudioPipeline(); return ipcRenderer.invoke('audio:stop-capture'); },
    isSupported:     ()    => ipcRenderer.invoke('audio:is-supported'),
  },

  devices: {
    getInputs:  () => ipcRenderer.invoke('devices:get-inputs'),
    getOutputs: () => ipcRenderer.invoke('devices:get-outputs'),
    setOutput:  async (deviceId) => {
      for (const el of document.querySelectorAll('audio, video')) {
        if (el.setSinkId) await el.setSinkId(deviceId);
      }
      return true;
    },
  },

  notify: (title, body, opts = {}) => ipcRenderer.invoke('notify', { title, body, ...opts }),

  settings: {
    get: (key)       => ipcRenderer.invoke('settings:get', key),
    set: (key, val)  => ipcRenderer.invoke('settings:set', key, val),
  },

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
  },

  getVersion: () => ipcRenderer.invoke('app:version'),
};

console.log('[Haven Desktop] App preload ready — per-app audio & enhanced features active');

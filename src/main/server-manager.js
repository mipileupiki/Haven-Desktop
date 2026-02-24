// ═══════════════════════════════════════════════════════════
// Haven Desktop — Server Manager
//
// Detects, starts, and manages a local Haven server process.
// ═══════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const net  = require('net');

class ServerManager {
  constructor(store) {
    this.store         = store;
    this.serverProcess = null;
    this._running      = false;
    this._port         = null;
  }

  // ── Detect a Haven server in common locations ────────────
  detectServer() {
    const candidates = [];

    // Saved path first
    const saved = this.store.get('userPrefs.serverPath');
    if (saved) candidates.push(saved);

    // Sibling directory (Haven-Desktop lives next to Haven)
    const parent = path.resolve(__dirname, '..', '..', '..');
    candidates.push(path.join(parent, 'Haven'));
    candidates.push(path.join(parent, 'haven'));

    // Common user locations
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
      candidates.push(path.join(home, 'Haven'));
      candidates.push(path.join(home, 'Desktop', 'Haven'));
      candidates.push(path.join(home, 'Documents', 'Haven'));
    }

    for (const dir of candidates) {
      const sjs = path.join(dir, 'server.js');
      const pkg = path.join(dir, 'package.json');

      if (fs.existsSync(sjs) && fs.existsSync(pkg)) {
        try {
          const json = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
          if (json.name === 'haven') {
            return { found: true, path: dir, version: json.version };
          }
        } catch { /* continue */ }
      }
    }

    return { found: false, path: null };
  }

  // ── Start the server ──────────────────────────────────────
  async startServer(serverDir) {
    if (this._running) return { success: true, port: this._port, url: `http://localhost:${this._port}` };

    const sjs = path.join(serverDir, 'server.js');
    if (!fs.existsSync(sjs)) {
      return { success: false, error: 'server.js not found in the chosen directory.' };
    }

    this._port = await this._findPort(3000);

    return new Promise(resolve => {
      const env = { ...process.env, PORT: String(this._port) };

      // Use system `node` (Electron's binary is not plain Node)
      const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';

      this.serverProcess = spawn(nodeCmd, [sjs], {
        cwd: serverDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });

      let resolved  = false;
      let isHTTPS   = false;   // detect from server output

      const finish = (ok, extra) => {
        if (resolved) return;
        resolved = true;
        this._running = ok;
        const protocol = isHTTPS ? 'https' : 'http';
        this._url = `${protocol}://localhost:${this._port}`;
        if (ok) this.store.set('userPrefs.serverPath', serverDir);
        resolve({ success: ok, port: this._port, url: this._url, ...extra });
      };

      this.serverProcess.stdout.on('data', (d) => {
        const msg = d.toString();
        this._emitLog(msg);

        // Haven prints "🔒 HTTPS enabled" when SSL certs are loaded
        if (/https enabled/i.test(msg)) isHTTPS = true;

        // Haven prints "Haven running on port …" or similar when ready
        if (!resolved && /listening|running|started/i.test(msg)) {
          finish(true);
        }
      });

      this.serverProcess.stderr.on('data', (d) => {
        this._emitLog('[ERR] ' + d.toString());
      });

      this.serverProcess.on('error', (err) => finish(false, { error: err.message }));
      this.serverProcess.on('exit', ()      => { this._running = false; });

      // Fallback: assume ready after 15 s no matter what
      setTimeout(() => finish(true), 15000);
    });
  }

  // ── Stop the server ───────────────────────────────────────
  stopServer() {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
    }
    this._running = false;
    this._port    = null;
    return { success: true };
  }

  // ── Status ────────────────────────────────────────────────
  getStatus() {
    return {
      running: this._running,
      port:    this._port,
      url:     this._running ? (this._url || `http://localhost:${this._port}`) : null,
    };
  }

  isRunning() { return this._running; }

  // ── Log forwarding ────────────────────────────────────────
  // Main process calls onLog() to subscribe; server-manager calls _emitLog()
  onLog(cb)    { this._logCb = cb; }
  _emitLog(msg) { if (this._logCb) this._logCb(msg); }

  // ── Port scanner ──────────────────────────────────────────
  async _findPort(start) {
    const test = (p) => new Promise(r => {
      const s = net.createServer();
      s.unref();
      s.on('error', () => r(false));
      s.listen(p, () => s.close(() => r(true)));
    });

    for (let p = start; p < start + 100; p++) {
      if (await test(p)) return p;
    }
    throw new Error('No available port found');
  }
}

module.exports = { ServerManager };

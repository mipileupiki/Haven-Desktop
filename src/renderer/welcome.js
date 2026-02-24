// ═══════════════════════════════════════════════════════════
// Haven Desktop — Welcome Screen Logic
// ═══════════════════════════════════════════════════════════

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const pages = document.querySelectorAll('.page');

  function showPage(id) {
    pages.forEach(p => p.classList.remove('active'));
    $(id).classList.add('active');
  }

  // ── Title-bar buttons ───────────────────────────────────
  $('#btn-min').onclick   = () => window.haven.window.minimize();
  $('#btn-close').onclick = () => window.haven.window.close();

  // ═══════ Page 1 — Choose Mode ═══════════════════════════

  $('#card-host').onclick = () => { showPage('#page-host'); detectServer(); };
  $('#card-join').onclick = () => { showPage('#page-join'); $('#server-url').focus(); };

  // ═══════ Page 2a — Host Flow ════════════════════════════

  $('#host-back').onclick = () => showPage('#page-choose');
  $('#btn-retry').onclick = () => detectServer();

  async function detectServer() {
    // Reset UI
    $('#host-detect').style.display    = 'flex';
    $('#host-found').style.display     = 'none';
    $('#host-missing').style.display   = 'none';
    $('#host-starting').style.display  = 'none';
    $('#host-error').style.display     = 'none';

    try {
      const result = await window.haven.server.detect();

      $('#host-detect').style.display = 'none';

      if (result.found) {
        $('#host-path').textContent    = result.path;
        $('#host-version').textContent = result.version ? `v${result.version}` : '';
        $('#host-found').style.display = 'block';
      } else {
        $('#host-missing').style.display = 'block';
      }
    } catch (err) {
      $('#host-detect').style.display  = 'none';
      $('#host-error-msg').textContent = err.message || 'Detection failed.';
      $('#host-error').style.display   = 'block';
    }
  }

  // Start server
  $('#btn-start-server').onclick = async () => {
    const serverPath = $('#host-path').textContent;
    await startServer(serverPath);
  };

  // Browse for server directory
  $('#btn-browse-server').onclick = async () => {
    const dir = await window.haven.server.browse();
    if (!dir) return;
    // Check if server.js exists there
    await startServer(dir);
  };

  // Fresh server setup — link to Haven repo / instructions
  $('#btn-setup-new').onclick = () => {
    window.haven.openExternal('https://github.com/ancsemi/Haven#one-click-setup');
  };

  async function startServer(serverPath) {
    $('#host-found').style.display    = 'none';
    $('#host-missing').style.display  = 'none';
    $('#host-error').style.display    = 'none';
    $('#host-starting').style.display = 'block';

    const logBox = $('#host-log');
    logBox.textContent = '';

    // Subscribe to server log
    window.haven.server.onLog((msg) => {
      logBox.textContent += msg;
      logBox.scrollTop = logBox.scrollHeight;
    });

    try {
      const res = await window.haven.server.start(serverPath);

      if (res.success) {
        const remember = $('#chk-remember').checked;
        const serverUrl = res.url || `http://localhost:${res.port}`;

        // Persist preferences
        await window.haven.settings.set('userPrefs', {
          mode: 'host',
          serverUrl: serverUrl,
          serverPath: serverPath,
          skipWelcome: remember,
        });

        // Navigate to app
        window.haven.nav.openApp(serverUrl);
      } else {
        $('#host-starting').style.display = 'none';
        $('#host-error-msg').textContent  = res.error || 'Failed to start server.';
        $('#host-error').style.display    = 'block';
      }
    } catch (err) {
      $('#host-starting').style.display = 'none';
      $('#host-error-msg').textContent  = err.message || 'Unexpected error.';
      $('#host-error').style.display    = 'block';
    }
  }

  // ═══════ Page 2b — Join Flow ════════════════════════════

  const urlInput   = $('#server-url');
  const connectBtn = $('#btn-connect');
  const joinError  = $('#join-error');

  $('#join-back').onclick = () => showPage('#page-choose');

  urlInput.addEventListener('input', () => {
    connectBtn.disabled = !urlInput.value.trim();
    joinError.style.display = 'none';
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !connectBtn.disabled) connectBtn.click();
  });

  connectBtn.onclick = async () => {
    let url = urlInput.value.trim();
    joinError.style.display = 'none';

    // Auto-prefix https if missing
    if (url && !url.match(/^https?:\/\//i)) {
      url = 'https://' + url;
      urlInput.value = url;
    }

    // Basic validation
    try {
      new URL(url);
    } catch {
      joinError.textContent   = 'Please enter a valid URL (e.g. https://haven.example.com)';
      joinError.style.display = 'block';
      return;
    }

    connectBtn.disabled    = true;
    connectBtn.textContent = 'Connecting…';

    try {
      // Quick health check — try to reach the server
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(url.replace(/\/+$/, '') + '/api/health', {
        signal: controller.signal,
      }).catch(() => null);

      clearTimeout(timeout);

      const remember  = $('#chk-remember').checked;
      const serverUrl = url.replace(/\/+$/, '');

      await window.haven.settings.set('userPrefs', {
        mode: 'join',
        serverUrl: serverUrl,
        serverPath: null,
        skipWelcome: remember,
      });

      window.haven.nav.openApp(serverUrl);

    } catch (err) {
      joinError.textContent = 'Could not reach the server. Check the address and try again.';
      joinError.style.display = 'block';
    } finally {
      connectBtn.disabled    = false;
      connectBtn.textContent = 'Connect';
    }
  };

})();

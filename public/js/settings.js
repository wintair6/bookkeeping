(function() {
  window.renderSettings = async function() {
    const el = document.getElementById('view-settings');
    const settings = await api('GET', '/api/settings');
    const params = new URLSearchParams(window.location.search);
    const gmailConnected = !!settings.gmail_oauth_tokens || params.get('gmail') === 'connected';

    el.innerHTML = `
      <h1>Settings</h1>
      <div style="max-width:520px">

        <section style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px">
          <h2 style="font-size:15px;margin-bottom:16px">Gmail</h2>
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="color:${gmailConnected ? 'var(--green)' : 'var(--text-muted)'}">
              ${gmailConnected ? '● Connected' : '○ Not connected'}
            </span>
            ${gmailConnected
              ? `<button class="btn btn-danger btn-sm" onclick="disconnectGmail()">Disconnect</button>`
              : `<a href="/api/auth/gmail" class="btn btn-primary btn-sm">Connect Gmail</a>`
            }
          </div>
          ${gmailConnected ? `<button class="btn btn-secondary btn-sm" style="margin-top:10px" onclick="triggerPoll()">Run Poll Now</button>` : ''}
        </section>

        <section style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px">
          <h2 style="font-size:15px;margin-bottom:16px">API Keys</h2>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Lexware API Key</span>
            <input id="lexware-key" type="password" placeholder="••••${settings.lexware_api_key || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Claude API Key</span>
            <input id="claude-key" type="password" placeholder="••••${settings.claude_api_key || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <button class="btn btn-primary btn-sm" onclick="saveKeys()">Save Keys</button>
        </section>

        <section style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px">
          <h2 style="font-size:15px;margin-bottom:16px">Configuration</h2>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Invoice Drop Folder</span>
            <input id="drop-folder" type="text" value="${settings.drop_folder_path || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Confidence Threshold: <strong id="threshold-val">${settings.confidence_threshold || 0.80}</strong></span>
            <input id="threshold" type="range" min="0.50" max="1.00" step="0.05" value="${settings.confidence_threshold || 0.80}"
              oninput="document.getElementById('threshold-val').textContent=this.value"
              style="width:100%;margin-top:8px;accent-color:var(--accent)">
          </label>
          <button class="btn btn-primary btn-sm" onclick="saveConfig()">Save Configuration</button>
        </section>

      </div>
    `;
  };

  window.saveKeys = async function() {
    const body = {};
    const lk = document.getElementById('lexware-key').value;
    const ck = document.getElementById('claude-key').value;
    if (lk) body.lexware_api_key = lk;
    if (ck) body.claude_api_key = ck;
    if (!Object.keys(body).length) return showToast('No changes', 'error');
    try { await api('PATCH', '/api/settings', body); showToast('Keys saved'); }
    catch (e) { showToast(e.message, 'error'); }
  };

  window.saveConfig = async function() {
    try {
      await api('PATCH', '/api/settings', {
        drop_folder_path: document.getElementById('drop-folder').value,
        confidence_threshold: document.getElementById('threshold').value,
      });
      showToast('Configuration saved');
    } catch (e) { showToast(e.message, 'error'); }
  };

  window.disconnectGmail = async function() {
    try { await api('POST', '/api/auth/gmail/disconnect'); showToast('Gmail disconnected'); renderSettings(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  window.triggerPoll = async function() {
    try { await api('POST', '/api/auth/gmail/poll'); showToast('Gmail poll triggered'); }
    catch (e) { showToast(e.message, 'error'); }
  };
})();

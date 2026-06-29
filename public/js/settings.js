(function() {
  window.renderSettings = async function() {
    const el = document.getElementById('view-settings');
    const settings = await api('GET', '/api/settings');
    const gmailStatus = settings.gmail_connection_status || '';
    const gmailEmail = settings.gmail_email || '';
    const hasCredentials = !!gmailEmail;

    let statusColor, statusText;
    if (gmailStatus === 'connected') {
      statusColor = 'var(--green)'; statusText = '● Verbunden';
    } else if (hasCredentials || gmailStatus === 'configured') {
      statusColor = 'var(--accent)'; statusText = '● Konfiguriert – noch nicht getestet';
    } else {
      statusColor = 'var(--text-muted)'; statusText = '○ Nicht konfiguriert';
    }

    el.innerHTML = `
      <h1>Einstellungen</h1>
      <div style="max-width:520px">

        <section style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px">
          <h2 style="font-size:15px;margin-bottom:4px">Gmail</h2>
          <div style="font-size:12px;margin-bottom:16px;color:${statusColor}">${statusText}</div>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">E-Mail-Adresse</span>
            <input id="gmail-email" type="email" value="${window.esc(gmailEmail)}" autocomplete="off"
              style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text-muted)">App-Passwort${settings.gmail_app_password ? ' (aktuell: ' + window.esc(settings.gmail_app_password) + ')' : ''}</span>
            <input id="gmail-app-password" type="password" placeholder="xxxx xxxx xxxx xxxx" autocomplete="new-password"
              style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <p style="font-size:11px;color:var(--text-muted);margin-bottom:14px">
            App-Passwort erstellen: Google-Konto → Sicherheit → 2-Faktor-Authentifizierung → App-Passwörter
          </p>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" onclick="saveGmail()">Speichern</button>
            <button id="gmail-test-btn" class="btn btn-secondary btn-sm" onclick="testGmail()" ${!hasCredentials ? 'disabled' : ''}>Testen</button>
          </div>
        </section>

        <section style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px">
          <h2 style="font-size:15px;margin-bottom:16px">API Keys</h2>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Lexware API Key</span>
            <input id="lexware-key" type="password" placeholder="${window.esc(settings.lexware_api_key ? '••••' + settings.lexware_api_key : '')}"
              style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Claude API Key</span>
            <input id="claude-key" type="password" placeholder="${window.esc(settings.claude_api_key ? '••••' + settings.claude_api_key : '')}"
              style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <button class="btn btn-primary btn-sm" onclick="saveKeys()">Speichern</button>
        </section>

        <section style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px">
          <h2 style="font-size:15px;margin-bottom:16px">Konfiguration</h2>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Eingangsordner für Rechnungen</span>
            <input id="drop-folder" type="text" value="${window.esc(settings.drop_folder_path || '')}"
              style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Konfidenz-Schwellenwert: <strong id="threshold-val">${settings.confidence_threshold || 0.80}</strong></span>
            <input id="threshold" type="range" min="0.50" max="1.00" step="0.05" value="${settings.confidence_threshold || 0.80}"
              oninput="document.getElementById('threshold-val').textContent=this.value"
              style="width:100%;margin-top:8px;accent-color:var(--accent)">
          </label>
          <button class="btn btn-primary btn-sm" onclick="saveConfig()">Speichern</button>
        </section>

        <section style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px">
          <h2 style="font-size:15px;margin-bottom:16px">Passwort ändern</h2>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Aktuelles Passwort</span>
            <input id="pw-current" type="password" autocomplete="current-password"
              style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Neues Passwort</span>
            <input id="pw-new" type="password" autocomplete="new-password"
              style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:16px">
            <span style="font-size:12px;color:var(--text-muted)">Neues Passwort wiederholen</span>
            <input id="pw-confirm" type="password" autocomplete="new-password"
              style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <div id="pw-error" style="display:none;color:var(--red);font-size:12px;margin-bottom:12px"></div>
          <button class="btn btn-primary btn-sm" onclick="changePassword()">Passwort ändern</button>
        </section>

      </div>
    `;
  };

  window.saveGmail = async function() {
    const email = document.getElementById('gmail-email').value.trim();
    const pass = document.getElementById('gmail-app-password').value;
    if (!email) return showToast('E-Mail-Adresse erforderlich', 'error');
    if (!pass) return showToast('App-Passwort erforderlich', 'error');
    try {
      await api('PATCH', '/api/settings', {
        gmail_email: email,
        gmail_app_password: pass,
        gmail_connection_status: 'configured',
      });
      showToast('Gmail-Zugangsdaten gespeichert');
      window.renderSettings();
    } catch (e) { showToast(e.message, 'error'); }
  };

  window.testGmail = async function() {
    const btn = document.getElementById('gmail-test-btn');
    btn.disabled = true;
    btn.textContent = 'Teste…';
    try {
      await api('POST', '/api/settings/gmail/test');
      showToast('Gmail-Verbindung erfolgreich');
      window.renderSettings();
    } catch (e) {
      showToast('Verbindungsfehler: ' + e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Testen';
    }
  };

  window.saveKeys = async function() {
    const body = {};
    const lk = document.getElementById('lexware-key').value;
    const ck = document.getElementById('claude-key').value;
    if (lk) body.lexware_api_key = lk;
    if (ck) body.claude_api_key = ck;
    if (!Object.keys(body).length) return showToast('Keine Änderungen', 'error');
    try { await api('PATCH', '/api/settings', body); showToast('API Keys gespeichert'); }
    catch (e) { showToast(e.message, 'error'); }
  };

  window.changePassword = async function() {
    const current = document.getElementById('pw-current').value;
    const next = document.getElementById('pw-new').value;
    const confirm = document.getElementById('pw-confirm').value;
    const errEl = document.getElementById('pw-error');
    errEl.style.display = 'none';

    if (!current || !next || !confirm) { errEl.textContent = 'Alle Felder ausfüllen.'; errEl.style.display = 'block'; return; }
    if (next.length < 8) { errEl.textContent = 'Neues Passwort muss mindestens 8 Zeichen haben.'; errEl.style.display = 'block'; return; }
    if (next !== confirm) { errEl.textContent = 'Passwörter stimmen nicht überein.'; errEl.style.display = 'block'; return; }

    try {
      await api('POST', '/api/auth/change-password', { currentPassword: current, newPassword: next });
      document.getElementById('pw-current').value = '';
      document.getElementById('pw-new').value = '';
      document.getElementById('pw-confirm').value = '';
      showToast('Passwort erfolgreich geändert');
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
    }
  };

  window.saveConfig = async function() {
    try {
      await api('PATCH', '/api/settings', {
        drop_folder_path: document.getElementById('drop-folder').value,
        confidence_threshold: document.getElementById('threshold').value,
      });
      showToast('Konfiguration gespeichert');
    } catch (e) { showToast(e.message, 'error'); }
  };
})();

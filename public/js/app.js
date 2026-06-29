// XSS escaping helper
window.esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const views = { queue: 'view-queue', review: 'view-review', reconciliation: 'view-reconciliation', settings: 'view-settings' };

function showApp() {
  document.getElementById('view-login').style.display = 'none';
  document.getElementById('sidebar').style.display = '';
  document.getElementById('main').style.display = '';
}

function showLogin() {
  document.getElementById('view-login').style.display = 'flex';
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('main').style.display = 'none';
}

function navigate(view) {
  Object.values(views).forEach(id => document.getElementById(id).style.display = 'none');
  document.querySelectorAll('.nav-link').forEach(a => a.classList.remove('active'));
  document.getElementById(views[view]).style.display = 'block';
  document.querySelector(`a[href="#${view}"]`).classList.add('active');
  if (view === 'queue') window.renderQueue?.();
  if (view === 'review') window.renderReview?.();
  if (view === 'reconciliation') window.renderReconciliation?.();
  if (view === 'settings') window.renderSettings?.();
}

document.querySelectorAll('.nav-link').forEach(a => {
  a.addEventListener('click', e => { e.preventDefault(); navigate(a.getAttribute('href').slice(1)); });
});

window.showToast = function(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = type;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
};

window.api = async function(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Nicht authentifiziert — bitte anmelden.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
};

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error?.message || 'Anmeldung fehlgeschlagen.';
      errEl.style.display = 'block';
      return;
    }
    showApp();
    navigate('queue');
  } catch (err) {
    errEl.textContent = err.message || 'Verbindungsfehler.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Anmelden';
  }
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}

document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('logout-btn').addEventListener('click', doLogout);
document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});
document.getElementById('forgot-btn').addEventListener('click', () => {
  const info = document.getElementById('forgot-info');
  info.style.display = info.style.display === 'none' ? 'block' : 'none';
});

// Boot: check authentication before showing the app
(async function boot() {
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('main').style.display = 'none';
  try {
    await fetch('/api/auth/me').then(async res => {
      if (res.ok) {
        showApp();
        const params = new URLSearchParams(window.location.search);
        const view = params.get('view') || 'queue';
        navigate(view);
        const gmailError = params.get('gmail_error');
        if (gmailError === 'missing_credentials') {
          setTimeout(() => showToast('Gmail-Verbindung fehlgeschlagen: GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET fehlen in der .env Datei.', 'error'), 300);
        } else if (gmailError) {
          setTimeout(() => showToast('Gmail-Fehler: ' + gmailError, 'error'), 300);
        }
        history.replaceState({}, '', '/');
      } else {
        showLogin();
      }
    });
  } catch (_) {
    showLogin();
  }
})();

const views = { queue: 'view-queue', review: 'view-review', reconciliation: 'view-reconciliation', settings: 'view-settings' };

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
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
};

navigate('queue');

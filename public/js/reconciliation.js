(function() {
  window.renderReconciliation = async function() {
    const el = document.getElementById('view-reconciliation');
    el.innerHTML = '<h1>Bank Reconciliation</h1><p style="color:var(--text-muted)">Loading…</p>';

    const { data } = await api('GET', '/api/invoices?status=reconciliation_proposed&page=1');
    if (!data.length) {
      el.innerHTML = '<h1>Bank Reconciliation</h1><p style="color:var(--text-muted);margin-top:32px">No pending matches.</p>';
      return;
    }

    const cards = data.map(inv => `
      <div style="display:flex;gap:24px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px;">
        <div style="flex:1">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Invoice</div>
          <div style="font-weight:600;margin-bottom:4px">${esc(inv.company_name) || '—'}</div>
          <div style="color:var(--text-muted)">${esc(inv.invoice_date) || ''}</div>
          <div style="font-size:20px;font-weight:700;margin-top:8px">€${(inv.amount_gross||0).toFixed(2)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${esc(inv.service_type) || ''} · ${inv.vat_rate ? inv.vat_rate + '% VAT' : ''}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:8px;word-break:break-all">${esc(inv.renamed_filename || inv.original_filename)}</div>
        </div>
        <div style="display:flex;align-items:center;font-size:20px;color:var(--text-muted)">→</div>
        <div style="flex:1;background:var(--surface2);border-radius:6px;padding:16px">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Proposed Bank Transaction</div>
          <div style="font-weight:600;margin-bottom:4px">Transaction ID: ${esc(inv.lexware_transaction_id) || '—'}</div>
        </div>
        <div style="display:flex;flex-direction:column;justify-content:center;gap:10px">
          <button class="btn btn-primary" onclick="confirmMatch(${inv.id})">Confirm Match</button>
          <button class="btn btn-danger" onclick="rejectMatch(${inv.id})">Reject</button>
        </div>
      </div>
    `).join('');

    el.innerHTML = `<h1>Bank Reconciliation (${data.length})</h1>${cards}`;
  };

  window.confirmMatch = async function(id) {
    try {
      await api('POST', `/api/invoices/${id}/reconcile`);
      showToast('Match confirmed in Lexware');
      renderReconciliation();
    } catch (e) { showToast(e.message, 'error'); }
  };

  window.rejectMatch = async function(id) {
    try {
      await api('POST', `/api/invoices/${id}/reject-match`);
      showToast('Match rejected');
      renderReconciliation();
    } catch (e) { showToast(e.message, 'error'); }
  };
})();

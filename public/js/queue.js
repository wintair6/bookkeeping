(function() {
  let currentPage = 1;
  let currentStatus = '';

  const STATUS_LABELS = {
    '': 'All', pending: 'Pending', extracting: 'Extracting',
    review_needed: 'Review', ready: 'Ready', uploaded: 'Uploaded',
    reconciliation_proposed: 'Propose', reconciled: 'Reconciled', failed: 'Failed',
  };

  window.renderQueue = async function(page = 1, status = currentStatus) {
    currentPage = page;
    currentStatus = status;
    const el = document.getElementById('view-queue');

    const params = new URLSearchParams({ page, ...(status && { status }) });
    const { data, total, pageSize } = await api('GET', `/api/invoices?${params}`);
    const totalPages = Math.ceil(total / pageSize);

    const filterBtns = Object.entries(STATUS_LABELS).map(([s, label]) =>
      `<button class="filter-btn ${s === status ? 'active' : ''}" onclick="renderQueue(1,'${s}')">${label}</button>`
    ).join('');

    const rows = data.map(inv => `
      <tr>
        <td>${inv.renamed_filename || inv.original_filename}</td>
        <td>${inv.company_name || '—'}</td>
        <td>${inv.invoice_date || '—'}</td>
        <td>${inv.vat_rate ? inv.vat_rate + '%' : '—'}</td>
        <td>${inv.amount_gross != null ? '€' + inv.amount_gross.toFixed(2) : '—'}</td>
        <td><span class="badge badge-${inv.status}">${inv.status.replace('_', ' ')}</span></td>
        <td>
          ${inv.status === 'failed' ? `<button class="btn btn-sm btn-secondary" onclick="retryInvoice(${inv.id})">Retry</button>` : ''}
          ${inv.status === 'ready' ? `<button class="btn btn-sm btn-primary" onclick="uploadInvoice(${inv.id})">Upload</button>` : ''}
          ${inv.error_message ? `<span style="color:var(--red);font-size:11px" title="${inv.error_message}">&#9888; error</span>` : ''}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:32px">No invoices</td></tr>`;

    const pagination = totalPages > 1 ? `
      <div class="pagination">
        <button class="btn btn-secondary btn-sm" onclick="renderQueue(${page-1},'${status}')" ${page===1?'disabled':''}>&#8592;</button>
        <span>${page} / ${totalPages}</span>
        <button class="btn btn-secondary btn-sm" onclick="renderQueue(${page+1},'${status}')" ${page===totalPages?'disabled':''}>&#8594;</button>
      </div>
    ` : '';

    el.innerHTML = `
      <h1>Invoice Queue</h1>
      <div class="filter-bar">${filterBtns}</div>
      <table>
        <thead><tr><th>File</th><th>Company</th><th>Date</th><th>VAT</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${pagination}
    `;
  };

  window.retryInvoice = async function(id) {
    try {
      await api('POST', `/api/invoices/${id}/retry`);
      showToast('Queued for retry');
      renderQueue(currentPage, currentStatus);
    } catch (e) { showToast(e.message, 'error'); }
  };

  window.uploadInvoice = async function(id) {
    try {
      await api('POST', `/api/invoices/${id}/upload`);
      showToast('Uploaded to Lexware');
      renderQueue(currentPage, currentStatus);
    } catch (e) { showToast(e.message, 'error'); }
  };
})();

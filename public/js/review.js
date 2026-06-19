(function() {
  window.renderReview = async function() {
    const el = document.getElementById('view-review');
    el.innerHTML = '<h1>Review Queue</h1><p style="color:var(--text-muted)">Loading…</p>';

    const { data } = await api('GET', '/api/invoices?status=review_needed&page=1');
    if (!data.length) {
      el.innerHTML = '<h1>Review Queue</h1><p style="color:var(--text-muted);margin-top:32px">No invoices need review.</p>';
      return;
    }

    el.innerHTML = `<h1>Review Queue (${data.length})</h1><div id="review-cards"></div>`;
    const container = document.getElementById('review-cards');

    for (const inv of data) {
      const card = document.createElement('div');
      card.style = 'display:flex;gap:24px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px;';
      card.innerHTML = `
        <div style="flex:1;min-width:0">
          <canvas id="pdf-canvas-${inv.id}" style="width:100%;border:1px solid var(--border);border-radius:4px"></canvas>
        </div>
        <div style="width:320px;flex-shrink:0">
          <div style="margin-bottom:12px;color:var(--text-muted);font-size:12px">EXTRACTION (${(inv.confidence_score*100).toFixed(0)}% confidence)</div>
          <label style="display:block;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text-muted)">Invoice Date</span>
            <input id="date-${inv.id}" type="date" value="${esc(inv.invoice_date) || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text-muted)">Company</span>
            <input id="company-${inv.id}" type="text" value="${esc(inv.company_name) || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text-muted)">VAT Rate</span>
            <select id="vat-${inv.id}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
              <option value="19" ${inv.vat_rate==19?'selected':''}>19%</option>
              <option value="7"  ${inv.vat_rate==7?'selected':''}>7%</option>
            </select>
          </label>
          <label style="display:block;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text-muted)">Service Type</span>
            <select id="type-${inv.id}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
              <option ${inv.service_type==='Dienstleistung'?'selected':''}>Dienstleistung</option>
              <option ${inv.service_type==='Lieferung'?'selected':''}>Lieferung</option>
              <option ${inv.service_type==='Sonstiges'?'selected':''}>Sonstiges</option>
            </select>
          </label>
          <label style="display:block;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text-muted)">Net Amount (€)</span>
            <input id="net-${inv.id}" type="number" step="0.01" value="${inv.amount_net || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:16px">
            <span style="font-size:12px;color:var(--text-muted)">Gross Amount (€)</span>
            <input id="gross-${inv.id}" type="number" step="0.01" value="${inv.amount_gross || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <button class="btn btn-primary" style="width:100%" onclick="submitReview(${inv.id})">Looks good — Upload</button>
        </div>
      `;
      container.appendChild(card);

      // Render PDF preview
      fetch(`/api/invoices/${inv.id}/pdf`).then(r => r.arrayBuffer()).then(buf => {
        pdfjsLib.getDocument({ data: buf }).promise.then(pdf => {
          pdf.getPage(1).then(page => {
            const canvas = document.getElementById(`pdf-canvas-${inv.id}`);
            const viewport = page.getViewport({ scale: 1.2 });
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            page.render({ canvasContext: canvas.getContext('2d'), viewport });
          });
        });
      }).catch(() => {});
    }
  };

  window.submitReview = async function(id) {
    const fields = {
      invoice_date: document.getElementById(`date-${id}`).value,
      company_name: document.getElementById(`company-${id}`).value,
      vat_rate: parseFloat(document.getElementById(`vat-${id}`).value),
      service_type: document.getElementById(`type-${id}`).value,
      amount_net: parseFloat(document.getElementById(`net-${id}`).value),
      amount_gross: parseFloat(document.getElementById(`gross-${id}`).value),
    };
    try {
      await api('PATCH', `/api/invoices/${id}`, fields);
      await api('POST', `/api/invoices/${id}/upload`);
      showToast('Corrected and uploaded to Lexware');
      renderReview();
    } catch (e) { showToast(e.message, 'error'); }
  };
})();

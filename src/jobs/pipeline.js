const { extractInvoiceData } = require('../services/pdfExtractor');
const { buildFilename } = require('../services/renamer');

async function processPending(db) {
  const pending = db.prepare(`SELECT * FROM invoices WHERE status='pending' LIMIT 5`).all();

  for (const invoice of pending) {
    db.prepare(`UPDATE invoices SET status='extracting', updated_at=datetime('now') WHERE id=?`).run(invoice.id);
    db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status) VALUES(?,?,?)`).run(invoice.id, 'pending', 'extracting');

    try {
      const thresholdRow = db.prepare(`SELECT encrypted_value FROM settings WHERE key='confidence_threshold'`).get();
      const threshold = parseFloat(thresholdRow?.encrypted_value || '0.80');

      const result = await extractInvoiceData(invoice.file_path);
      const renamed = buildFilename(result.invoice_date, result.company_name, db);
      const newStatus = result.confidence_score >= threshold ? 'ready' : 'review_needed';

      db.prepare(`
        UPDATE invoices SET
          status=?, renamed_filename=?, invoice_date=?, company_name=?,
          vat_rate=?, service_type=?, amount_net=?, amount_gross=?,
          confidence_score=?, error_message=NULL, updated_at=datetime('now')
        WHERE id=?
      `).run(newStatus, renamed, result.invoice_date, result.company_name,
             result.vat_rate, result.service_type, result.amount_net, result.amount_gross,
             result.confidence_score, invoice.id);

      db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status) VALUES(?,?,?)`).run(invoice.id, 'extracting', newStatus);
      console.log(`[pipeline] ${invoice.original_filename} → ${newStatus} (${(result.confidence_score * 100).toFixed(0)}%)`);
    } catch (err) {
      db.prepare(`
        UPDATE invoices SET status='failed', error_message=?, updated_at=datetime('now') WHERE id=?
      `).run(err.message, invoice.id);
      db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status, detail) VALUES(?,?,?,?)`).run(invoice.id, 'extracting', 'failed', err.message);
      console.error(`[pipeline] failed: ${invoice.original_filename} — ${err.message}`);
    }
  }
}

function startPipeline(db) {
  setInterval(() => processPending(db).catch(console.error), 30_000);
  processPending(db).catch(console.error); // run immediately on boot
}

module.exports = { startPipeline, processPending };

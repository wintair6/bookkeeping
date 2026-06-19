'use strict';

const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/connection');
const { uploadVoucher, reconcile: lexwareReconcile } = require('../services/lexwareClient');
const { findMatch } = require('../services/reconciler');
const { z } = require('zod');

const PAGE_SIZE = 25;

// List invoices
router.get('/api/invoices', requireAuth, (req, res) => {
  const db = getDb();
  const { status, page = 1 } = req.query;
  const offset = (Number(page) - 1) * PAGE_SIZE;
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];

  const total = db.prepare(`SELECT COUNT(*) as n FROM invoices ${where}`).get(...params).n;
  const data = db.prepare(`SELECT * FROM invoices ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, offset);

  res.json({ data, total, page: Number(page), pageSize: PAGE_SIZE });
});

// Correct extracted fields
const PatchSchema = z.object({
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  company_name: z.string().min(1).optional(),
  vat_rate: z.number().optional(),
  service_type: z.enum(['Dienstleistung', 'Lieferung', 'Sonstiges']).optional(),
  amount_net: z.number().positive().optional(),
  amount_gross: z.number().positive().optional(),
});

router.patch('/api/invoices/:id', requireAuth, (req, res, next) => {
  try {
    const fields = PatchSchema.parse(req.body);
    const db = getDb();
    const sets = Object.keys(fields).map(k => `${k}=?`).join(', ');
    if (!sets) return res.json({ ok: true });
    db.prepare(`UPDATE invoices SET ${sets}, updated_at=datetime('now') WHERE id=?`).run(...Object.values(fields), req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Upload to Lexware
router.post('/api/invoices/:id/upload', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id=?`).get(req.params.id);
    if (!invoice) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice not found', details: null } });

    const pdfBuffer = fs.readFileSync(invoice.file_path);
    const { voucherId } = await uploadVoucher(invoice, pdfBuffer, db);

    // Move file to processed/
    const folderRow = db.prepare(`SELECT encrypted_value FROM settings WHERE key='drop_folder_path'`).get();
    if (folderRow?.encrypted_value) {
      const processedDir = path.join(folderRow.encrypted_value, 'processed');
      fs.mkdirSync(processedDir, { recursive: true });
      const dest = path.join(folderRow.encrypted_value, 'processed', invoice.renamed_filename || path.basename(invoice.file_path));
      fs.renameSync(invoice.file_path, dest);
      db.prepare(`UPDATE invoices SET file_path=? WHERE id=?`).run(dest, invoice.id);
    }

    db.prepare(`UPDATE invoices SET status='uploaded', lexware_voucher_id=?, updated_at=datetime('now') WHERE id=?`).run(voucherId, invoice.id);
    db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status) VALUES(?,?,?)`).run(invoice.id, invoice.status, 'uploaded');

    // Kick off reconciliation in background (fire and forget)
    const updatedInvoice = { ...invoice, lexware_voucher_id: voucherId };
    findMatch(updatedInvoice, db).then(match => {
      if (!match) return;
      db.prepare(`
        UPDATE invoices SET status='reconciliation_proposed', lexware_transaction_id=?, updated_at=datetime('now') WHERE id=?
      `).run(match.transactionId, invoice.id);
      db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status, detail) VALUES(?,?,?,?)`)
        .run(invoice.id, 'uploaded', 'reconciliation_proposed', 'auto-matched by reconciler');
    }).catch(console.error);

    res.json({ ok: true, voucherId });
  } catch (err) { next(err); }
});

// Confirm reconciliation
router.post('/api/invoices/:id/reconcile', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id=?`).get(req.params.id);
    if (!invoice) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice not found', details: null } });

    await lexwareReconcile(invoice.lexware_voucher_id, invoice.lexware_transaction_id, db);
    db.prepare(`UPDATE invoices SET status='reconciled', updated_at=datetime('now') WHERE id=?`).run(invoice.id);
    db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status) VALUES(?,?,?)`).run(invoice.id, 'reconciliation_proposed', 'reconciled');

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Reject proposed match
router.post('/api/invoices/:id/reject-match', requireAuth, (req, res) => {
  const db = getDb();
  const inv = db.prepare(`SELECT id FROM invoices WHERE id=?`).get(req.params.id);
  if (!inv) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice not found', details: null } });
  db.prepare(`UPDATE invoices SET status='uploaded', lexware_transaction_id=NULL, updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status, detail) VALUES(?,?,?,?)`).run(req.params.id, 'reconciliation_proposed', 'uploaded', 'match rejected by user');
  res.json({ ok: true });
});

// Retry failed
router.post('/api/invoices/:id/retry', requireAuth, (req, res) => {
  const db = getDb();
  const inv = db.prepare(`SELECT id FROM invoices WHERE id=?`).get(req.params.id);
  if (!inv) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice not found', details: null } });
  db.prepare(`UPDATE invoices SET status='pending', error_message=NULL, updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status, detail) VALUES(?,?,?,?)`).run(req.params.id, 'failed', 'pending', 'manual retry');
  res.json({ ok: true });
});

// Poll log for an invoice
router.get('/api/invoices/:id/log', requireAuth, (req, res) => {
  const log = getDb().prepare(`SELECT * FROM processing_log WHERE invoice_id=? ORDER BY created_at`).all(req.params.id);
  res.json(log);
});

// Stream PDF file
router.get('/api/invoices/:id/pdf', requireAuth, (req, res, next) => {
  try {
    const db = getDb();
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id=?`).get(req.params.id);
    if (!invoice) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice not found', details: null } });
    if (!invoice.file_path || !fs.existsSync(invoice.file_path)) {
      return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: 'PDF file not found on disk', details: null } });
    }
    res.setHeader('Content-Type', 'application/pdf');
    fs.createReadStream(invoice.file_path).pipe(res);
  } catch (err) { next(err); }
});

module.exports = router;

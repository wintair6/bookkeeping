CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK(source IN ('gmail','folder')),
  original_filename TEXT NOT NULL,
  renamed_filename TEXT,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','extracting','review_needed','ready','uploaded',
                     'reconciliation_proposed','reconciled','failed')),
  invoice_date TEXT,
  company_name TEXT,
  vat_rate REAL,
  service_type TEXT,
  amount_net REAL,
  amount_gross REAL,
  confidence_score REAL,
  lexware_voucher_id TEXT,
  lexware_transaction_id TEXT,
  gmail_message_id TEXT UNIQUE,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_name);

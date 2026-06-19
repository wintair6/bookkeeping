CREATE TABLE IF NOT EXISTS gmail_poll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  emails_scanned INTEGER DEFAULT 0,
  attachments_found INTEGER DEFAULT 0,
  error TEXT
);

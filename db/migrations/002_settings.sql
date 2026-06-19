CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  encrypted_value TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

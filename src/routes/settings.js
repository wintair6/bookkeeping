const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { encrypt, decrypt } = require('../services/encryptor');
const { getDb } = require('../db/connection');

const MASKED_KEYS = ['lexware_api_key', 'claude_api_key', 'gmail_app_password'];
const PLAIN_KEYS  = ['confidence_threshold', 'drop_folder_path', 'gmail_filter', 'gmail_email', 'gmail_connection_status'];

function maskValue(key, raw) {
  if (!raw) return '';
  if (MASKED_KEYS.includes(key)) {
    try { raw = decrypt(raw); } catch { return '••••'; }
    return raw.length > 4 ? '••••' + raw.slice(-4) : '••••';
  }
  return raw;
}

router.get('/api/settings', requireAuth, (req, res) => {
  const rows = getDb().prepare('SELECT key, encrypted_value FROM settings').all();
  const result = {};
  for (const row of rows) result[row.key] = maskValue(row.key, row.encrypted_value);
  res.json(result);
});

router.patch('/api/settings', requireAuth, (req, res) => {
  const db = getDb();
  const allowed = [...MASKED_KEYS, ...PLAIN_KEYS];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  const stmt = db.prepare(`
    INSERT INTO settings(key, encrypted_value, updated_at) VALUES(?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value, updated_at=excluded.updated_at
  `);
  const txn = db.transaction(() => {
    for (const [key, value] of updates) {
      const stored = MASKED_KEYS.includes(key) ? encrypt(String(value)) : String(value);
      stmt.run(key, stored);
    }
  });
  txn();
  res.json({ ok: true });
});

router.post('/api/settings/gmail/test', requireAuth, async (req, res) => {
  try {
    const { testConnection } = require('../jobs/gmailPoller');
    await testConnection(getDb());
    getDb().prepare(`
      INSERT INTO settings(key, encrypted_value, updated_at) VALUES('gmail_connection_status', 'connected', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET encrypted_value='connected', updated_at=excluded.updated_at
    `).run();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: { code: 'GMAIL_CONNECTION_FAILED', message: err.message, details: null } });
  }
});

module.exports = router;

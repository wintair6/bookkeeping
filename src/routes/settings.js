const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { encrypt, decrypt } = require('../services/encryptor');
const { getDb } = require('../db/connection');

const MASKED_KEYS = ['lexware_api_key', 'claude_api_key', 'gmail_oauth_tokens'];
const PLAIN_KEYS  = ['confidence_threshold', 'drop_folder_path', 'gmail_filter'];

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

const { getOAuthClient } = require('../jobs/gmailPoller');

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

router.get('/api/auth/gmail', requireAuth, (req, res) => {
  const auth = getOAuthClient();
  const url = auth.generateAuthUrl({ access_type: 'offline', scope: GMAIL_SCOPES, prompt: 'consent' });
  res.redirect(url);
});

router.get('/api/auth/gmail/callback', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.query;
    const auth = getOAuthClient();
    const { tokens } = await auth.getToken(code);
    const db = getDb();
    db.prepare(`
      INSERT INTO settings(key, encrypted_value, updated_at) VALUES('gmail_oauth_tokens', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value, updated_at=excluded.updated_at
    `).run(encrypt(JSON.stringify(tokens)));
    res.redirect('/?view=settings&gmail=connected');
  } catch (err) { next(err); }
});

router.post('/api/auth/gmail/disconnect', requireAuth, (req, res) => {
  getDb().prepare(`DELETE FROM settings WHERE key='gmail_oauth_tokens'`).run();
  res.json({ ok: true });
});

router.post('/api/auth/gmail/poll', requireAuth, async (req, res, next) => {
  try {
    const { pollGmail } = require('../jobs/gmailPoller');
    await pollGmail(getDb());
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;

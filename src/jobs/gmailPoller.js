const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const { decrypt, encrypt } = require('../services/encryptor');

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/auth/gmail/callback'
  );
}

async function pollGmail(db) {
  const runId = db.prepare(
    `INSERT INTO gmail_poll_runs(started_at) VALUES(datetime('now'))`
  ).run().lastInsertRowid;

  try {
    const tokenRow = db.prepare(`SELECT encrypted_value FROM settings WHERE key='gmail_oauth_tokens'`).get();
    if (!tokenRow) throw new Error('Gmail not connected — no OAuth tokens');

    const tokens = JSON.parse(decrypt(tokenRow.encrypted_value));
    const auth = getOAuthClient();
    auth.setCredentials(tokens);

    // Auto-refresh tokens
    auth.on('tokens', newTokens => {
      const merged = { ...tokens, ...newTokens };
      db.prepare(`
        INSERT INTO settings(key, encrypted_value, updated_at) VALUES('gmail_oauth_tokens', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value, updated_at=excluded.updated_at
      `).run(encrypt(JSON.stringify(merged)));
    });

    const gmail = google.gmail({ version: 'v1', auth });
    const filterRow = db.prepare(`SELECT encrypted_value FROM settings WHERE key='gmail_filter'`).get();
    const q = filterRow?.encrypted_value || 'has:attachment filename:pdf';

    const listRes = await gmail.users.messages.list({ userId: 'me', q, maxResults: 50 });
    const messages = listRes.data.messages || [];
    let attachmentsFound = 0;

    const folderRow = db.prepare(`SELECT encrypted_value FROM settings WHERE key='drop_folder_path'`).get();
    const dropFolder = folderRow?.encrypted_value;
    if (!dropFolder) throw new Error('drop_folder_path not configured');
    const inboxDir = path.join(dropFolder, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    for (const msg of messages) {
      const existing = db.prepare(`SELECT id FROM invoices WHERE gmail_message_id=?`).get(msg.id);
      if (existing) continue;

      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id });
      const parts = full.data.payload?.parts || [];

      for (const part of parts) {
        if (part.mimeType !== 'application/pdf' && !part.filename?.endsWith('.pdf')) continue;
        const attId = part.body?.attachmentId;
        if (!attId) continue;

        const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId: msg.id, id: attId });
        const data = Buffer.from(att.data.data, 'base64url');
        const filename = part.filename || `gmail-${msg.id}.pdf`;
        const filePath = path.join(inboxDir, filename);
        fs.writeFileSync(filePath, data);

        db.prepare(`
          INSERT INTO invoices(source, original_filename, file_path, gmail_message_id, status)
          VALUES('gmail', ?, ?, ?, 'pending')
          ON CONFLICT(gmail_message_id) DO NOTHING
        `).run(filename, filePath, msg.id);
        attachmentsFound++;
      }
    }

    db.prepare(`
      UPDATE gmail_poll_runs SET completed_at=datetime('now'), emails_scanned=?, attachments_found=? WHERE id=?
    `).run(messages.length, attachmentsFound, runId);
    console.log(`[gmailPoller] scanned ${messages.length} emails, found ${attachmentsFound} attachments`);
  } catch (err) {
    db.prepare(`
      UPDATE gmail_poll_runs SET completed_at=datetime('now'), error=? WHERE id=?
    `).run(err.message, runId);
    console.error(`[gmailPoller] error: ${err.message}`);
  }
}

function startGmailPoller(db) {
  cron.schedule('0 * * * *', () => pollGmail(db)); // top of every hour
  console.log('[gmailPoller] scheduled — runs every 60 min');
}

module.exports = { startGmailPoller, pollGmail, getOAuthClient };

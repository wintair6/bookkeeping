const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { decrypt } = require('../services/encryptor');

async function getImapCredentials(db) {
  const emailRow = db.prepare(`SELECT encrypted_value FROM settings WHERE key='gmail_email'`).get();
  const passRow  = db.prepare(`SELECT encrypted_value FROM settings WHERE key='gmail_app_password'`).get();
  if (!emailRow?.encrypted_value || !passRow?.encrypted_value) return null;
  return {
    email: emailRow.encrypted_value,
    password: decrypt(passRow.encrypted_value),
  };
}

function makeClient(email, password) {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
  });
}

async function testConnection(db) {
  const creds = await getImapCredentials(db);
  if (!creds) throw new Error('Keine Zugangsdaten konfiguriert');
  const client = makeClient(creds.email, creds.password);
  await client.connect();
  await client.logout();
}

async function pollGmail(db) {
  const runId = db.prepare(
    `INSERT INTO gmail_poll_runs(started_at) VALUES(datetime('now'))`
  ).run().lastInsertRowid;

  try {
    const creds = await getImapCredentials(db);
    if (!creds) throw new Error('Gmail nicht konfiguriert — E-Mail und App-Passwort fehlen');

    const folderRow = db.prepare(`SELECT encrypted_value FROM settings WHERE key='drop_folder_path'`).get();
    const dropFolder = folderRow?.encrypted_value;
    if (!dropFolder) throw new Error('drop_folder_path not configured');
    const inboxDir = path.join(dropFolder, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    const client = makeClient(creds.email, creds.password);
    await client.connect();

    let emailsScanned = 0;
    let attachmentsFound = 0;

    await client.mailboxOpen('INBOX');

    // Search for emails with PDF attachments not yet seen
    for await (const msg of client.fetch('1:*', { envelope: true, bodyStructure: true, uid: true })) {
      emailsScanned++;
      const uid = String(msg.uid);

      const existing = db.prepare(`SELECT id FROM invoices WHERE gmail_message_id=?`).get(uid);
      if (existing) continue;

      // Check if message has PDF attachments
      const hasPdf = hasPdfAttachment(msg.bodyStructure);
      if (!hasPdf) continue;

      // Fetch full message to parse attachments
      const { content } = await client.download(msg.uid, undefined, { uid: true });
      const chunks = [];
      for await (const chunk of content) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const parsed = await simpleParser(raw);

      for (const att of (parsed.attachments || [])) {
        if (!att.filename?.toLowerCase().endsWith('.pdf') && att.contentType !== 'application/pdf') continue;
        const filename = att.filename || `gmail-${uid}.pdf`;
        const filePath = path.join(inboxDir, filename);
        fs.writeFileSync(filePath, att.content);

        db.prepare(`
          INSERT INTO invoices(source, original_filename, file_path, gmail_message_id, status)
          VALUES('gmail', ?, ?, ?, 'pending')
          ON CONFLICT(gmail_message_id) DO NOTHING
        `).run(filename, filePath, uid);
        attachmentsFound++;
      }
    }

    await client.logout();

    db.prepare(`
      UPDATE gmail_poll_runs SET completed_at=datetime('now'), emails_scanned=?, attachments_found=? WHERE id=?
    `).run(emailsScanned, attachmentsFound, runId);
    console.log(`[gmailPoller] scanned ${emailsScanned} emails, found ${attachmentsFound} PDF attachments`);
  } catch (err) {
    db.prepare(`
      UPDATE gmail_poll_runs SET completed_at=datetime('now'), error=? WHERE id=?
    `).run(err.message, runId);
    console.error(`[gmailPoller] error: ${err.message}`);
  }
}

function hasPdfAttachment(structure) {
  if (!structure) return false;
  if (structure.type === 'attachment' &&
      (structure.disposition?.filename?.toLowerCase().endsWith('.pdf') ||
       structure.parameters?.name?.toLowerCase().endsWith('.pdf'))) return true;
  if (Array.isArray(structure.childNodes)) {
    return structure.childNodes.some(hasPdfAttachment);
  }
  return false;
}

function startGmailPoller(db) {
  cron.schedule('0 * * * *', () => pollGmail(db));
  console.log('[gmailPoller] scheduled — runs every 60 min');
}

module.exports = { startGmailPoller, pollGmail, testConnection };

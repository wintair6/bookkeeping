require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getDb } = require('../src/db/connection');

async function seed() {
  const db = getDb();
  const email = process.env.ADMIN_EMAIL || 'admin@local';
  const password = process.env.ADMIN_PASSWORD || 'changeme';
  const hash = await bcrypt.hash(password, 12);

  db.prepare(`
    INSERT INTO users(email, password_hash) VALUES(?,?)
    ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash
  `).run(email, hash);

  const defaults = [
    ['confidence_threshold', '0.80'],
    ['drop_folder_path', process.env.INVOICE_FOLDER || ''],
  ];
  for (const [key, val] of defaults) {
    db.prepare(`
      INSERT INTO settings(key, encrypted_value) VALUES(?,?)
      ON CONFLICT(key) DO NOTHING
    `).run(key, val);
  }

  console.log(`Seed complete. Admin: ${email}`);
}

seed().catch(console.error);

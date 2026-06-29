#!/usr/bin/env node
// Notfall-Passwort-Reset — direkt auf der DB, kein Login erforderlich
// Aufruf: node scripts/reset-password.js
require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../bookkeeping.db');
const db = new Database(dbPath);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));

async function main() {
  const users = db.prepare('SELECT id, email FROM users').all();
  if (!users.length) { console.error('Keine Benutzer in der Datenbank.'); process.exit(1); }

  console.log('\nBuchführung — Passwort zurücksetzen\n');
  users.forEach((u, i) => console.log(`  [${i + 1}] ${u.email}`));

  let user;
  if (users.length === 1) {
    user = users[0];
    console.log(`\nBenutzer: ${user.email}`);
  } else {
    const choice = await ask('\nNummer wählen: ');
    user = users[parseInt(choice, 10) - 1];
    if (!user) { console.error('Ungültige Auswahl.'); process.exit(1); }
  }

  const newPassword = await ask('Neues Passwort (mind. 8 Zeichen): ');
  if (newPassword.length < 8) { console.error('Passwort zu kurz.'); process.exit(1); }

  const confirm = await ask('Passwort bestätigen: ');
  if (newPassword !== confirm) { console.error('Passwörter stimmen nicht überein.'); process.exit(1); }

  const hash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id);
  console.log(`\n✓ Passwort für ${user.email} wurde zurückgesetzt.\n`);
  rl.close();
}

main().catch(err => { console.error(err.message); process.exit(1); });

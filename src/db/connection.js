const Database = require('better-sqlite3');
const path = require('path');
const { runMigrations } = require('./migrations');

let instance;

function getDb() {
  if (instance) return instance;
  const dbPath = path.join(__dirname, '../../data.db');
  instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  runMigrations(instance);
  return instance;
}

module.exports = { getDb };

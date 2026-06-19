const fs = require('fs');
const path = require('path');

function runMigrations(db) {
  db.exec(fs.readFileSync(path.join(__dirname, '../../db/migrations/001_schema_migrations.sql'), 'utf8'));

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
  );

  const migDir = path.join(__dirname, '../../db/migrations');
  const files = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(file);
    console.log(`[migration] applied ${file}`);
  }
}

module.exports = { runMigrations };

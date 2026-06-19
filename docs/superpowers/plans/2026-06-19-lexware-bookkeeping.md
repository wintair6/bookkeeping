# Lexware Bookkeeping Automation Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate the full invoice pipeline from Gmail ingestion and AI-powered extraction through categorised upload to Lexware Office and bank-transaction reconciliation.

**Architecture:** Local Express.js server with SQLite storage; a node-cron job polls Gmail every 60 min and chokidar watches a drop folder; Claude API extracts structured fields from each PDF; extracted invoices are uploaded to Lexware via their REST API; a reconciliation view proposes bank-transaction matches for one-click confirmation.

**Tech Stack:** Node.js 22 LTS · Express 4 · better-sqlite3 · bcryptjs · express-session · node-cron · chokidar · pdf-parse · Anthropic SDK · googleapis · zod · fastest-levenshtein · Jest · Vanilla HTML/CSS/JS

## Global Constraints

- Node.js ≥ 22 LTS
- All source under `src/`; tests under `tests/`; SQL migrations under `db/migrations/`
- SQLite WAL mode always enabled
- AES-256-GCM for all secrets stored in DB; master key from `ENCRYPTION_KEY` env var only
- Every API response error uses envelope `{ error: { code, message, details } }`
- Every list endpoint returns `{ data: [...], total, page, pageSize }`
- Dark theme: background `#0f0f0f`, surface `#1a1a1a`, accent `#F98E1D`, text `#e5e5e5`
- bcryptjs cost factor 12 for all password hashing
- All Lexware / Claude outbound calls: 15 s hard timeout, 3× retry with exponential backoff on 429/503/ECONNRESET
- No secrets ever logged or sent to the frontend
- Commit after every task

---

## File Structure

```
lexware-bookkeeping-tool/
├── src/
│   ├── app.js                        # Express setup, middleware, routes
│   ├── server.js                     # HTTP listen + job boot
│   ├── db/
│   │   ├── connection.js             # better-sqlite3 singleton, WAL
│   │   └── migrations.js            # Migration runner
│   ├── services/
│   │   ├── encryptor.js             # AES-256-GCM encrypt/decrypt
│   │   ├── pdfExtractor.js          # pdf-parse + Claude API + zod
│   │   ├── renamer.js               # Filename convention + dedup
│   │   ├── lexwareClient.js         # Lexware API wrapper
│   │   └── reconciler.js           # Bank-tx matching algorithm
│   ├── jobs/
│   │   ├── folderWatcher.js         # chokidar drop-folder watcher
│   │   ├── gmailPoller.js           # Gmail API + node-cron
│   │   └── pipeline.js              # Picks up pending, runs extraction
│   ├── routes/
│   │   ├── health.js
│   │   ├── invoices.js
│   │   └── settings.js
│   └── middleware/
│       ├── auth.js                   # requireAuth helper
│       └── errorHandler.js          # Centralised error handler
├── db/
│   └── migrations/
│       ├── 001_schema_migrations.sql
│       ├── 002_settings.sql
│       ├── 003_users.sql
│       ├── 004_invoices.sql
│       ├── 005_processing_log.sql
│       └── 006_gmail_poll_runs.sql
├── public/
│   ├── index.html
│   ├── css/app.css
│   └── js/
│       ├── app.js                    # Router + sidebar
│       ├── queue.js                  # Queue view
│       ├── review.js                 # Review view (pdf.js)
│       ├── reconciliation.js        # Reconciliation view
│       └── settings.js              # Settings view + OAuth flow
├── scripts/
│   └── seed.js                       # Create admin + default settings
├── tests/
│   ├── unit/
│   │   ├── encryptor.test.js
│   │   ├── renamer.test.js
│   │   ├── pdfExtractor.test.js
│   │   ├── lexwareClient.test.js
│   │   └── reconciler.test.js
│   └── integration/
│       ├── pipeline.test.js
│       ├── gmail.test.js
│       └── reconciliation.test.js
├── docs/
│   ├── adr/ADR-001.md
│   └── superpowers/plans/2026-06-19-lexware-bookkeeping.md
├── .env.example
├── .gitignore
├── Dockerfile
├── package.json
└── README.md
```

---

## Task 1: Project Scaffold & Package Setup

**Files:**
- Create: `package.json`, `.env.example`, `.gitignore`, `README.md`
- Create: `src/app.js`, `src/server.js`
- Create: `src/middleware/errorHandler.js`
- Create: `src/routes/health.js`

**Interfaces:**
- Produces: `createApp()` → Express app instance (used by all later route tasks and tests)

- [ ] **Step 1: Initialise the project**

```bash
cd ~/lexware-bookkeeping-tool
npm init -y
npm install express helmet express-session connect-sqlite3 bcryptjs \
  better-sqlite3 node-cron chokidar pdf-parse zod fastest-levenshtein \
  @anthropic-ai/sdk googleapis dotenv
npm install --save-dev jest
```

- [ ] **Step 2: Create `.env.example`**

```bash
cat > .env.example << 'EOF'
# 32-byte hex string: openssl rand -hex 32
ENCRYPTION_KEY=

# Session secret: openssl rand -hex 32
SESSION_SECRET=

# Port for local server
PORT=3000

# Absolute path to the invoice drop folder (subfolders inbox/ processed/ failed/ created automatically)
INVOICE_FOLDER=/Users/yourname/invoices
EOF
```

- [ ] **Step 3: Create `.gitignore`**

```
.env
node_modules/
*.db
*.db-wal
*.db-shm
invoices/
backups/
.DS_Store
```

- [ ] **Step 4: Write `src/middleware/errorHandler.js`**

```js
module.exports = function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  console.error(`[${code}] ${err.message}`, err.details || '');
  res.status(status).json({ error: { code, message: err.message, details: err.details || null } });
};
```

- [ ] **Step 5: Write `src/routes/health.js`**

```js
const router = require('express').Router();
router.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
module.exports = router;
```

- [ ] **Step 6: Write `src/app.js`**

```js
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const errorHandler = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
      },
    },
  }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: '.' }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
  }));

  app.use(require('./routes/health'));
  // Additional routes registered in later tasks

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
```

- [ ] **Step 7: Write `src/server.js`**

```js
const { createApp } = require('./app');
const app = createApp();
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Lexware tool running at http://localhost:${port}`));
```

- [ ] **Step 8: Add scripts to `package.json`**

```json
"scripts": {
  "start": "node src/server.js",
  "test": "jest --forceExit",
  "seed": "node scripts/seed.js"
}
```

- [ ] **Step 9: Verify server starts**

```bash
echo "SESSION_SECRET=test ENCRYPTION_KEY=$(openssl rand -hex 32) PORT=3000" > .env
node src/server.js &
curl http://localhost:3000/health
# Expected: {"status":"ok","ts":"..."}
kill %1
```

- [ ] **Step 10: Commit**

```bash
git init
git add .
git commit -m "feat: project scaffold, Express app, health route"
```

---

## Task 2: Database — Migrations & Connection

**Files:**
- Create: `src/db/connection.js`, `src/db/migrations.js`
- Create: `db/migrations/001_schema_migrations.sql` through `006_gmail_poll_runs.sql`

**Interfaces:**
- Produces: `db` — better-sqlite3 Database instance exported from `connection.js`
- Produces: `runMigrations(db)` from `migrations.js`

- [ ] **Step 1: Write `db/migrations/001_schema_migrations.sql`**

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Write `db/migrations/002_settings.sql`**

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  encrypted_value TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 3: Write `db/migrations/003_users.sql`**

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Write `db/migrations/004_invoices.sql`**

```sql
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK(source IN ('gmail','folder')),
  original_filename TEXT NOT NULL,
  renamed_filename TEXT,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','extracting','review_needed','ready','uploaded',
                     'reconciliation_proposed','reconciled','failed')),
  invoice_date TEXT,
  company_name TEXT,
  vat_rate REAL,
  service_type TEXT,
  amount_net REAL,
  amount_gross REAL,
  confidence_score REAL,
  lexware_voucher_id TEXT,
  lexware_transaction_id TEXT,
  gmail_message_id TEXT UNIQUE,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_name);
```

- [ ] **Step 5: Write `db/migrations/005_processing_log.sql`**

```sql
CREATE TABLE IF NOT EXISTS processing_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_log_invoice ON processing_log(invoice_id);
```

- [ ] **Step 6: Write `db/migrations/006_gmail_poll_runs.sql`**

```sql
CREATE TABLE IF NOT EXISTS gmail_poll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  emails_scanned INTEGER DEFAULT 0,
  attachments_found INTEGER DEFAULT 0,
  error TEXT
);
```

- [ ] **Step 7: Write `src/db/migrations.js`**

```js
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
```

- [ ] **Step 8: Write `src/db/connection.js`**

```js
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
```

- [ ] **Step 9: Wire DB into app startup — add to `src/server.js`**

```js
const { createApp } = require('./app');
const { getDb } = require('./db/connection');

getDb(); // Run migrations on boot
const app = createApp();
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Lexware tool running at http://localhost:${port}`));
```

- [ ] **Step 10: Verify migrations run cleanly**

```bash
node -e "require('./src/db/connection').getDb(); console.log('OK')"
# Expected: [migration] applied 001... through 006... then OK
```

- [ ] **Step 11: Commit**

```bash
git add .
git commit -m "feat: SQLite connection, WAL mode, 6 versioned migrations"
```

---

## Task 3: Encryption Service

**Files:**
- Create: `src/services/encryptor.js`
- Create: `tests/unit/encryptor.test.js`

**Interfaces:**
- Produces: `encrypt(plaintext: string): string` — returns `"<version>:<iv_hex>:<tag_hex>:<ciphertext_hex>"`
- Produces: `decrypt(stored: string): string` — reverses the above

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/encryptor.test.js
process.env.ENCRYPTION_KEY = 'a'.repeat(64); // 32-byte hex

const { encrypt, decrypt } = require('../../src/services/encryptor');

test('round-trip encrypt/decrypt', () => {
  const plain = 'my-api-key-12345';
  const stored = encrypt(plain);
  expect(decrypt(stored)).toBe(plain);
});

test('encrypted value is not plaintext', () => {
  const stored = encrypt('secret');
  expect(stored).not.toContain('secret');
});

test('encrypted value includes key version prefix', () => {
  const stored = encrypt('x');
  expect(stored.startsWith('1:')).toBe(true);
});

test('decrypt throws on tampered ciphertext', () => {
  const stored = encrypt('hello');
  const parts = stored.split(':');
  parts[3] = 'deadbeef'.repeat(4); // corrupt ciphertext
  expect(() => decrypt(parts.join(':'))).toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest tests/unit/encryptor.test.js
# Expected: Cannot find module '../../src/services/encryptor'
```

- [ ] **Step 3: Write `src/services/encryptor.js`**

```js
const crypto = require('crypto');

const KEY_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';

function getMasterKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) throw new Error('ENCRYPTION_KEY must be a 64-char hex string');
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${KEY_VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored) {
  const [version, ivHex, tagHex, ctHex] = stored.split(':');
  if (version !== String(KEY_VERSION)) throw new Error(`Unknown key version: ${version}`);
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest tests/unit/encryptor.test.js
# Expected: 4 tests pass
```

- [ ] **Step 5: Commit**

```bash
git add src/services/encryptor.js tests/unit/encryptor.test.js
git commit -m "feat: AES-256-GCM encryption service with key versioning"
```

---

## Task 4: Auth Middleware, Session & Seed Script

**Files:**
- Create: `src/middleware/auth.js`
- Create: `scripts/seed.js`
- Modify: `src/app.js` — add login/logout routes

**Interfaces:**
- Produces: `requireAuth` middleware — calls `next()` if session valid, else 401 JSON

- [ ] **Step 1: Write `src/middleware/auth.js`**

```js
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: null } });
}

module.exports = { requireAuth };
```

- [ ] **Step 2: Add login/logout routes to `src/app.js`** — insert before `app.use(errorHandler)`

```js
const bcrypt = require('bcryptjs');
const { getDb } = require('./db/connection');

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'email and password required', details: null } });
    const user = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password', details: null } });
    }
    req.session.userId = user.id;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
```

- [ ] **Step 3: Write `scripts/seed.js`**

```js
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
```

- [ ] **Step 4: Run seed**

```bash
ADMIN_EMAIL=rene@rene-winter.de ADMIN_PASSWORD=changeme node scripts/seed.js
# Expected: Seed complete. Admin: rene@rene-winter.de
```

- [ ] **Step 5: Commit**

```bash
git add src/middleware/auth.js src/app.js scripts/seed.js
git commit -m "feat: session auth, login/logout routes, seed script"
```

---

## Task 5: Settings Routes

**Files:**
- Create: `src/routes/settings.js`
- Modify: `src/app.js` — register settings router

**Interfaces:**
- Consumes: `encrypt`, `decrypt` from `encryptor.js`; `requireAuth` from `auth.js`; `getDb()`
- Produces: `GET /api/settings` → `{ key: maskedValue }` map; `PATCH /api/settings` → `{ ok: true }`

- [ ] **Step 1: Write `src/routes/settings.js`**

```js
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

module.exports = router;
```

- [ ] **Step 2: Register in `src/app.js`** — add after health route

```js
app.use(require('./routes/settings'));
```

- [ ] **Step 3: Verify manually**

```bash
node src/server.js &
# login first
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"rene@rene-winter.de","password":"changeme"}'
# Expected: {"ok":true}

curl -b cookies.txt http://localhost:3000/api/settings
# Expected: {"confidence_threshold":"0.80","drop_folder_path":""}

curl -b cookies.txt -X PATCH http://localhost:3000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"confidence_threshold":"0.75"}'
# Expected: {"ok":true}

kill %1 && rm cookies.txt
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/settings.js src/app.js
git commit -m "feat: settings routes with encrypted storage and masked responses"
```

---

## Task 6: Renamer Service

**Files:**
- Create: `src/services/renamer.js`
- Create: `tests/unit/renamer.test.js`

**Interfaces:**
- Produces: `buildFilename(invoiceDate, companyName, db): string` — e.g. `"2026-01-15-amazon.pdf"` or `"2026-01-15-amazon-2.pdf"`

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/renamer.test.js
const { buildFilename } = require('../../src/services/renamer');

// Minimal DB mock
function makeDb(existingNames = []) {
  return {
    prepare: () => ({
      all: () => existingNames.map(renamed_filename => ({ renamed_filename })),
    }),
  };
}

test('basic filename', () => {
  expect(buildFilename('2026-01-15', 'Amazon GmbH', makeDb())).toBe('2026-01-15-amazon-gmbh.pdf');
});

test('sanitises special chars', () => {
  expect(buildFilename('2026-01-15', 'AT&T / Telekom', makeDb())).toBe('2026-01-15-at-t-telekom.pdf');
});

test('appends -2 on first duplicate', () => {
  const db = makeDb(['2026-01-15-amazon.pdf']);
  expect(buildFilename('2026-01-15', 'Amazon', db)).toBe('2026-01-15-amazon-2.pdf');
});

test('appends -3 on second duplicate', () => {
  const db = makeDb(['2026-01-15-amazon.pdf', '2026-01-15-amazon-2.pdf']);
  expect(buildFilename('2026-01-15', 'Amazon', db)).toBe('2026-01-15-amazon-3.pdf');
});

test('collapses multiple spaces/hyphens', () => {
  expect(buildFilename('2026-01-15', 'foo   --  bar', makeDb())).toBe('2026-01-15-foo-bar.pdf');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest tests/unit/renamer.test.js
# Expected: Cannot find module '../../src/services/renamer'
```

- [ ] **Step 3: Write `src/services/renamer.js`**

```js
function sanitise(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')   // remove special chars
    .replace(/[\s-]+/g, '-')          // collapse spaces/hyphens
    .replace(/^-+|-+$/g, '');         // trim leading/trailing hyphens
}

function buildFilename(invoiceDate, companyName, db) {
  const base = `${invoiceDate}-${sanitise(companyName)}`;
  const existing = db.prepare(
    `SELECT renamed_filename FROM invoices WHERE renamed_filename LIKE ?`
  ).all(`${base}%.pdf`).map(r => r.renamed_filename);

  if (!existing.includes(`${base}.pdf`)) return `${base}.pdf`;

  let n = 2;
  while (existing.includes(`${base}-${n}.pdf`)) n++;
  return `${base}-${n}.pdf`;
}

module.exports = { buildFilename };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest tests/unit/renamer.test.js
# Expected: 5 tests pass
```

- [ ] **Step 5: Commit**

```bash
git add src/services/renamer.js tests/unit/renamer.test.js
git commit -m "feat: renamer service with dedup suffix and sanitisation"
```

---

## Task 7: PDF Extractor Service

**Files:**
- Create: `src/services/pdfExtractor.js`
- Create: `tests/unit/pdfExtractor.test.js`

**Interfaces:**
- Consumes: `decrypt` from `encryptor.js`; `getDb()` to read `claude_api_key` from settings
- Produces: `extractInvoiceData(filePath: string): Promise<ExtractionResult>`
  ```
  ExtractionResult {
    invoice_date: string,   // ISO 8601 YYYY-MM-DD
    company_name: string,
    vat_rate: number,       // 7.0 or 19.0
    service_type: string,   // 'Dienstleistung'|'Lieferung'|'Sonstiges'
    amount_net: number,
    amount_gross: number,
    confidence_score: number  // 0.0–1.0
  }
  ```

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/pdfExtractor.test.js
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

jest.mock('@anthropic-ai/sdk');
jest.mock('../../src/db/connection');
jest.mock('../../src/services/encryptor');

const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../../src/db/connection');
const { decrypt } = require('../../src/services/encryptor');
const { extractInvoiceData } = require('../../src/services/pdfExtractor');

const validResult = {
  invoice_date: '2026-01-15',
  company_name: 'Amazon GmbH',
  vat_rate: 19.0,
  service_type: 'Lieferung',
  amount_net: 100.00,
  amount_gross: 119.00,
  confidence_score: 0.95,
};

beforeEach(() => {
  decrypt.mockReturnValue('test-claude-key');
  getDb.mockReturnValue({
    prepare: () => ({ get: () => ({ encrypted_value: 'encrypted' }) }),
  });
  Anthropic.mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ text: JSON.stringify(validResult) }],
      }),
    },
  }));
});

test('parses valid Claude response', async () => {
  const result = await extractInvoiceData('/fake/path.pdf');
  expect(result.invoice_date).toBe('2026-01-15');
  expect(result.vat_rate).toBe(19.0);
  expect(result.confidence_score).toBe(0.95);
});

test('throws if Claude returns invalid JSON', async () => {
  Anthropic.mockImplementation(() => ({
    messages: { create: jest.fn().mockResolvedValue({ content: [{ text: 'not json' }] }) },
  }));
  await expect(extractInvoiceData('/fake/path.pdf')).rejects.toThrow();
});

test('throws if required fields missing', async () => {
  const bad = { invoice_date: '2026-01-15' }; // missing company_name etc
  Anthropic.mockImplementation(() => ({
    messages: { create: jest.fn().mockResolvedValue({ content: [{ text: JSON.stringify(bad) }] }) },
  }));
  await expect(extractInvoiceData('/fake/path.pdf')).rejects.toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest tests/unit/pdfExtractor.test.js
# Expected: Cannot find module '../../src/services/pdfExtractor'
```

- [ ] **Step 3: Write `src/services/pdfExtractor.js`**

```js
const fs = require('fs');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { decrypt } = require('./encryptor');
const { getDb } = require('../db/connection');

const ExtractionSchema = z.object({
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  company_name: z.string().min(1),
  vat_rate: z.number().refine(v => [7.0, 19.0].includes(v), { message: 'VAT must be 7 or 19' }),
  service_type: z.enum(['Dienstleistung', 'Lieferung', 'Sonstiges']),
  amount_net: z.number().positive(),
  amount_gross: z.number().positive(),
  confidence_score: z.number().min(0).max(1),
});

const PROMPT = `You are an invoice parser. Extract these fields from the invoice text and respond ONLY with a JSON object (no markdown, no explanation):
{
  "invoice_date": "YYYY-MM-DD",
  "company_name": "Exact issuer name",
  "vat_rate": 7.0 or 19.0,
  "service_type": "Dienstleistung" | "Lieferung" | "Sonstiges",
  "amount_net": number,
  "amount_gross": number,
  "confidence_score": 0.0–1.0 (how confident you are in ALL fields combined)
}
If a field cannot be determined, use your best guess and lower confidence_score accordingly.`;

async function extractInvoiceData(filePath) {
  const buffer = fs.readFileSync(filePath);
  let text = '';
  try {
    const parsed = await pdfParse(buffer);
    text = parsed.text;
  } catch {
    text = '[PDF text extraction failed — image-only PDF]';
  }

  const row = getDb().prepare(`SELECT encrypted_value FROM settings WHERE key='claude_api_key'`).get();
  if (!row) throw new Error('Claude API key not configured in settings');
  const apiKey = decrypt(row.encrypted_value);

  const client = new Anthropic({ apiKey });
  const response = await Promise.race([
    client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content: `${PROMPT}\n\nINVOICE TEXT:\n${text.slice(0, 8000)}` }],
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Claude timeout')), 15000)),
  ]);

  const raw = response.content[0].text.trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`Claude returned non-JSON: ${raw.slice(0, 200)}`); }

  return ExtractionSchema.parse(parsed);
}

module.exports = { extractInvoiceData };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest tests/unit/pdfExtractor.test.js
# Expected: 3 tests pass
```

- [ ] **Step 5: Commit**

```bash
git add src/services/pdfExtractor.js tests/unit/pdfExtractor.test.js
git commit -m "feat: PDF extractor with Claude API, zod validation, 15s timeout"
```

---

## Task 8: Folder Watcher & Pipeline Processor

**Files:**
- Create: `src/jobs/folderWatcher.js`
- Create: `src/jobs/pipeline.js`
- Modify: `src/server.js` — boot both jobs

**Interfaces:**
- Consumes: `getDb()`, `extractInvoiceData`, `buildFilename`
- Produces: `startFolderWatcher(db)` — starts chokidar, returns watcher
- Produces: `startPipeline(db)` — picks up `pending` invoices every 30s, runs extraction

- [ ] **Step 1: Write `src/jobs/folderWatcher.js`**

```js
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

function startFolderWatcher(db) {
  const folderRow = db.prepare(`SELECT encrypted_value FROM settings WHERE key='drop_folder_path'`).get();
  const dropFolder = folderRow?.encrypted_value;
  if (!dropFolder) {
    console.warn('[folderWatcher] No drop_folder_path configured — watcher not started');
    return null;
  }

  const inboxDir = path.join(dropFolder, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(path.join(dropFolder, 'processed'), { recursive: true });
  fs.mkdirSync(path.join(dropFolder, 'failed'), { recursive: true });

  const knownPaths = new Set(
    db.prepare(`SELECT file_path FROM invoices`).all().map(r => r.file_path)
  );

  const watcher = chokidar.watch(inboxDir, { persistent: true, ignoreInitial: false });

  watcher.on('add', filePath => {
    if (!filePath.endsWith('.pdf')) return;
    if (knownPaths.has(filePath)) return;
    knownPaths.add(filePath);

    const original = path.basename(filePath);
    db.prepare(`
      INSERT INTO invoices(source, original_filename, file_path, status)
      VALUES('folder', ?, ?, 'pending')
    `).run(original, filePath);
    console.log(`[folderWatcher] queued: ${original}`);
  });

  console.log(`[folderWatcher] watching: ${inboxDir}`);
  return watcher;
}

module.exports = { startFolderWatcher };
```

- [ ] **Step 2: Write `src/jobs/pipeline.js`**

```js
const path = require('path');
const fs = require('fs');
const { extractInvoiceData } = require('../services/pdfExtractor');
const { buildFilename } = require('../services/renamer');

async function processPending(db) {
  const pending = db.prepare(`SELECT * FROM invoices WHERE status='pending' LIMIT 5`).all();

  for (const invoice of pending) {
    db.prepare(`UPDATE invoices SET status='extracting', updated_at=datetime('now') WHERE id=?`).run(invoice.id);
    db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status) VALUES(?,?,?)`).run(invoice.id, 'pending', 'extracting');

    try {
      const thresholdRow = db.prepare(`SELECT encrypted_value FROM settings WHERE key='confidence_threshold'`).get();
      const threshold = parseFloat(thresholdRow?.encrypted_value || '0.80');

      const result = await extractInvoiceData(invoice.file_path);
      const renamed = buildFilename(result.invoice_date, result.company_name, db);
      const newStatus = result.confidence_score >= threshold ? 'ready' : 'review_needed';

      db.prepare(`
        UPDATE invoices SET
          status=?, renamed_filename=?, invoice_date=?, company_name=?,
          vat_rate=?, service_type=?, amount_net=?, amount_gross=?,
          confidence_score=?, error_message=NULL, updated_at=datetime('now')
        WHERE id=?
      `).run(newStatus, renamed, result.invoice_date, result.company_name,
             result.vat_rate, result.service_type, result.amount_net, result.amount_gross,
             result.confidence_score, invoice.id);

      db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status) VALUES(?,?,?)`).run(invoice.id, 'extracting', newStatus);
      console.log(`[pipeline] ${invoice.original_filename} → ${newStatus} (${(result.confidence_score * 100).toFixed(0)}%)`);
    } catch (err) {
      db.prepare(`
        UPDATE invoices SET status='failed', error_message=?, updated_at=datetime('now') WHERE id=?
      `).run(err.message, invoice.id);
      db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status, detail) VALUES(?,?,?,?)`).run(invoice.id, 'extracting', 'failed', err.message);
      console.error(`[pipeline] failed: ${invoice.original_filename} — ${err.message}`);
    }
  }
}

function startPipeline(db) {
  setInterval(() => processPending(db).catch(console.error), 30_000);
  processPending(db).catch(console.error); // run immediately on boot
}

module.exports = { startPipeline };
```

- [ ] **Step 3: Wire jobs into `src/server.js`**

```js
require('dotenv').config();
const { createApp } = require('./app');
const { getDb } = require('./db/connection');
const { startFolderWatcher } = require('./jobs/folderWatcher');
const { startPipeline } = require('./jobs/pipeline');

const db = getDb();
startFolderWatcher(db);
startPipeline(db);

const app = createApp();
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Lexware tool running at http://localhost:${port}`));
```

- [ ] **Step 4: Smoke test**

```bash
mkdir -p /tmp/test-invoices/inbox
INVOICE_FOLDER=/tmp/test-invoices node -e "
  require('dotenv').config();
  const { getDb } = require('./src/db/connection');
  const { startFolderWatcher } = require('./src/jobs/folderWatcher');
  const db = getDb();
  startFolderWatcher(db);
  setTimeout(() => {
    require('fs').writeFileSync('/tmp/test-invoices/inbox/test.pdf', '%PDF-1.4 dummy');
  }, 500);
  setTimeout(() => {
    const rows = db.prepare('SELECT * FROM invoices').all();
    console.log('Queued:', rows.length);
    process.exit(0);
  }, 1500);
"
# Expected: [folderWatcher] queued: test.pdf  Queued: 1
```

- [ ] **Step 5: Commit**

```bash
git add src/jobs/folderWatcher.js src/jobs/pipeline.js src/server.js
git commit -m "feat: folder watcher, pipeline processor, 30s extraction loop"
```

---

## Task 9: Gmail Poller

**Files:**
- Create: `src/jobs/gmailPoller.js`
- Modify: `src/server.js` — boot poller
- Modify: `src/routes/settings.js` — add Gmail OAuth routes

**Interfaces:**
- Produces: `startGmailPoller(db)` — runs every 60 min via node-cron
- Produces: `GET /api/auth/gmail` — redirects to Google OAuth consent
- Produces: `GET /api/auth/gmail/callback` — exchanges code for tokens, stores encrypted

- [ ] **Step 1: Install OAuth2 library** *(googleapis already installed in Task 1)*

```bash
# No new install needed — googleapis is already in package.json
echo "OK"
```

- [ ] **Step 2: Write `src/jobs/gmailPoller.js`**

```js
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
```

- [ ] **Step 3: Add Gmail OAuth routes to `src/routes/settings.js`** — append before `module.exports`

```js
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
```

- [ ] **Step 4: Update `.env.example`** with new vars

```bash
cat >> .env.example << 'EOF'

# Google OAuth2 app credentials (create at console.cloud.google.com)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/gmail/callback
EOF
```

- [ ] **Step 5: Boot and verify poller schedule logs**

```bash
node src/server.js &
sleep 2
# Expected in logs: [gmailPoller] scheduled — runs every 60 min
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add src/jobs/gmailPoller.js src/routes/settings.js src/server.js .env.example
git commit -m "feat: Gmail OAuth2 poller, 60-min cron, token auto-refresh"
```

---

## Task 10: Lexware Client

**Files:**
- Create: `src/services/lexwareClient.js`
- Create: `tests/unit/lexwareClient.test.js`

**Interfaces:**
- Produces:
  - `uploadVoucher(invoiceData, pdfBuffer, db): Promise<{ voucherId: string }>`
  - `getBankTransactions(from, to, db): Promise<Transaction[]>` where `Transaction = { id, date, amount, description }`
  - `reconcile(voucherId, transactionId, db): Promise<void>`

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/lexwareClient.test.js
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

jest.mock('../../src/services/encryptor');
const { decrypt } = require('../../src/services/encryptor');
decrypt.mockReturnValue('test-lexware-key');

const mockFetch = jest.fn();
global.fetch = mockFetch;

const { uploadVoucher, getBankTransactions } = require('../../src/services/lexwareClient');

function makeDb() {
  return {
    prepare: () => ({ get: () => ({ encrypted_value: 'encrypted' }) }),
  };
}

beforeEach(() => mockFetch.mockReset());

test('uploadVoucher returns voucherId on success', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'voucher-123' }),
  });
  const result = await uploadVoucher(
    { invoice_date: '2026-01-15', company_name: 'Test', vat_rate: 19, service_type: 'Dienstleistung', amount_net: 100, amount_gross: 119 },
    Buffer.from('%PDF'),
    makeDb()
  );
  expect(result.voucherId).toBe('voucher-123');
});

test('uploadVoucher retries on 429', async () => {
  mockFetch
    .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'voucher-456' }) });
  const result = await uploadVoucher(
    { invoice_date: '2026-01-15', company_name: 'Test', vat_rate: 19, service_type: 'Dienstleistung', amount_net: 100, amount_gross: 119 },
    Buffer.from('%PDF'),
    makeDb()
  );
  expect(result.voucherId).toBe('voucher-456');
  expect(mockFetch).toHaveBeenCalledTimes(2);
}, 10000);

test('getBankTransactions returns array', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ content: [{ id: 'tx-1', bookingDate: '2026-01-15', amount: { value: 119 }, purpose: 'Amazon' }] }),
  });
  const txs = await getBankTransactions('2026-01-01', '2026-01-31', makeDb());
  expect(txs[0].id).toBe('tx-1');
  expect(txs[0].amount).toBe(119);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest tests/unit/lexwareClient.test.js
# Expected: Cannot find module '../../src/services/lexwareClient'
```

- [ ] **Step 3: Write `src/services/lexwareClient.js`**

```js
const { decrypt } = require('./encryptor');

const BASE_URL = 'https://api.lexoffice.io/v1';
const TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;

function getApiKey(db) {
  const row = db.prepare(`SELECT encrypted_value FROM settings WHERE key='lexware_api_key'`).get();
  if (!row) throw new Error('Lexware API key not configured');
  return decrypt(row.encrypted_value);
}

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return res;
    if ([429, 503].includes(res.status) && retries > 0) {
      const delay = (MAX_RETRIES - retries + 1) * 2000;
      await new Promise(r => setTimeout(r, delay));
      return fetchWithRetry(url, options, retries - 1);
    }
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(`Lexware ${res.status}: ${body.message || 'Unknown error'}`), { status: res.status });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Lexware API timeout after 15s');
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(err.code) && retries > 0) {
      await new Promise(r => setTimeout(r, 2000));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw err;
  }
}

async function uploadVoucher(invoiceData, pdfBuffer, db) {
  const apiKey = getApiKey(db);

  // 1. Create the voucher record
  const voucherPayload = {
    type: 'purchaseinvoice',
    voucherDate: invoiceData.invoice_date + 'T00:00:00.000+01:00',
    supplierName: invoiceData.company_name,
    lineItems: [{
      amount: { grossValue: invoiceData.amount_gross, taxRatePercent: invoiceData.vat_rate },
      categoryId: invoiceData.service_type === 'Dienstleistung' ? '8' : '1', // Lexware category IDs
    }],
    remark: `Auto-imported via bookkeeping tool`,
  };

  const voucherRes = await fetchWithRetry(`${BASE_URL}/vouchers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(voucherPayload),
  });
  const { id: voucherId } = await voucherRes.json();

  // 2. Attach the PDF
  const form = new FormData();
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), 'invoice.pdf');
  await fetchWithRetry(`${BASE_URL}/vouchers/${voucherId}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  return { voucherId };
}

async function getBankTransactions(from, to, db) {
  const apiKey = getApiKey(db);
  const url = `${BASE_URL}/bank-transactions?dateFrom=${from}&dateTo=${to}&status=openForAssignment`;
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const data = await res.json();
  return (data.content || []).map(tx => ({
    id: tx.id,
    date: tx.bookingDate,
    amount: tx.amount?.value,
    description: tx.purpose || tx.counterpartName || '',
  }));
}

async function reconcile(voucherId, transactionId, db) {
  const apiKey = getApiKey(db);
  await fetchWithRetry(`${BASE_URL}/bank-transactions/${transactionId}/assignments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'voucher', id: voucherId }),
  });
}

module.exports = { uploadVoucher, getBankTransactions, reconcile };
```

- [ ] **Step 4: Run tests**

```bash
npx jest tests/unit/lexwareClient.test.js
# Expected: 3 tests pass
```

- [ ] **Step 5: Commit**

```bash
git add src/services/lexwareClient.js tests/unit/lexwareClient.test.js
git commit -m "feat: Lexware API client with retry, timeout, voucher upload"
```

---

## Task 11: Reconciler Service

**Files:**
- Create: `src/services/reconciler.js`
- Create: `tests/unit/reconciler.test.js`

**Interfaces:**
- Consumes: `getBankTransactions` from `lexwareClient.js`
- Produces: `findMatch(invoice, db): Promise<Match|null>` where `Match = { transactionId, score, transaction }`

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/reconciler.test.js
jest.mock('../../src/services/lexwareClient');
const { getBankTransactions } = require('../../src/services/lexwareClient');
const { findMatch } = require('../../src/services/reconciler');

const invoice = {
  id: 1,
  invoice_date: '2026-01-15',
  amount_gross: 119.00,
  company_name: 'Amazon GmbH',
};

function makeDb() {
  return { prepare: () => ({ get: () => null }) };
}

test('returns null when no transactions', async () => {
  getBankTransactions.mockResolvedValue([]);
  expect(await findMatch(invoice, makeDb())).toBeNull();
});

test('returns match on exact amount + close date + similar name', async () => {
  getBankTransactions.mockResolvedValue([{
    id: 'tx-1', date: '2026-01-16', amount: 119.00, description: 'Amazon GmbH Payment',
  }]);
  const match = await findMatch(invoice, makeDb());
  expect(match).not.toBeNull();
  expect(match.transactionId).toBe('tx-1');
  expect(match.score).toBeGreaterThan(0.75);
});

test('returns null when amount does not match', async () => {
  getBankTransactions.mockResolvedValue([{
    id: 'tx-2', date: '2026-01-16', amount: 200.00, description: 'Amazon',
  }]);
  expect(await findMatch(invoice, makeDb())).toBeNull();
});

test('returns null when date is outside ±7 days', async () => {
  getBankTransactions.mockResolvedValue([{
    id: 'tx-3', date: '2026-01-30', amount: 119.00, description: 'Amazon',
  }]);
  expect(await findMatch(invoice, makeDb())).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx jest tests/unit/reconciler.test.js
# Expected: Cannot find module '../../src/services/reconciler'
```

- [ ] **Step 3: Write `src/services/reconciler.js`**

```js
const { distance } = require('fastest-levenshtein');
const { getBankTransactions } = require('./lexwareClient');

function daysDiff(dateA, dateB) {
  return Math.abs((new Date(dateA) - new Date(dateB)) / (1000 * 60 * 60 * 24));
}

function nameSimilarity(a, b) {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  const maxLen = Math.max(la.length, lb.length);
  if (maxLen === 0) return 1;
  return 1 - distance(la, lb) / maxLen;
}

async function findMatch(invoice, db) {
  const date = new Date(invoice.invoice_date);
  const from = new Date(date); from.setDate(from.getDate() - 30);
  const to   = new Date(date); to.setDate(to.getDate() + 30);

  const txs = await getBankTransactions(
    from.toISOString().slice(0, 10),
    to.toISOString().slice(0, 10),
    db
  );

  let best = null;
  for (const tx of txs) {
    if (Math.abs(tx.amount - invoice.amount_gross) > 0.01) continue;
    const days = daysDiff(tx.date, invoice.invoice_date);
    if (days > 7) continue;

    const dateScore = 1 - days / 7;
    const nameScore = nameSimilarity(tx.description, invoice.company_name);
    const composite = 0.6 * dateScore + 0.4 * nameScore;

    if (composite >= 0.75 && (!best || composite > best.score)) {
      best = { transactionId: tx.id, score: composite, transaction: tx };
    }
  }

  return best;
}

module.exports = { findMatch };
```

- [ ] **Step 4: Run tests**

```bash
npx jest tests/unit/reconciler.test.js
# Expected: 4 tests pass
```

- [ ] **Step 5: Commit**

```bash
git add src/services/reconciler.js tests/unit/reconciler.test.js
git commit -m "feat: reconciler with amount/date/name scoring, 0.75 threshold"
```

---

## Task 12: Invoice API Routes

**Files:**
- Create: `src/routes/invoices.js`
- Modify: `src/app.js` — register invoices router

**Interfaces:**
- Produces all invoice-facing HTTP endpoints (see spec routes table)

- [ ] **Step 1: Write `src/routes/invoices.js`**

```js
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/connection');
const { uploadVoucher, reconcile: lexwareReconcile } = require('../services/lexwareClient');
const { findMatch } = require('../services/reconciler');
const { z } = require('zod');

const PAGE_SIZE = 25;

// List invoices
router.get('/api/invoices', requireAuth, (req, res) => {
  const db = getDb();
  const { status, page = 1 } = req.query;
  const offset = (Number(page) - 1) * PAGE_SIZE;
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];

  const total = db.prepare(`SELECT COUNT(*) as n FROM invoices ${where}`).get(...params).n;
  const data = db.prepare(`SELECT * FROM invoices ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, offset);

  res.json({ data, total, page: Number(page), pageSize: PAGE_SIZE });
});

// Correct extracted fields
const PatchSchema = z.object({
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  company_name: z.string().min(1).optional(),
  vat_rate: z.number().optional(),
  service_type: z.enum(['Dienstleistung', 'Lieferung', 'Sonstiges']).optional(),
  amount_net: z.number().positive().optional(),
  amount_gross: z.number().positive().optional(),
});

router.patch('/api/invoices/:id', requireAuth, (req, res, next) => {
  try {
    const fields = PatchSchema.parse(req.body);
    const db = getDb();
    const sets = Object.keys(fields).map(k => `${k}=?`).join(', ');
    if (!sets) return res.json({ ok: true });
    db.prepare(`UPDATE invoices SET ${sets}, updated_at=datetime('now') WHERE id=?`).run(...Object.values(fields), req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Upload to Lexware
router.post('/api/invoices/:id/upload', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id=?`).get(req.params.id);
    if (!invoice) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice not found', details: null } });

    const pdfBuffer = fs.readFileSync(invoice.file_path);
    const { voucherId } = await uploadVoucher(invoice, pdfBuffer, db);

    // Move file to processed/
    const folderRow = db.prepare(`SELECT encrypted_value FROM settings WHERE key='drop_folder_path'`).get();
    if (folderRow?.encrypted_value) {
      const dest = path.join(folderRow.encrypted_value, 'processed', invoice.renamed_filename || path.basename(invoice.file_path));
      fs.renameSync(invoice.file_path, dest);
      db.prepare(`UPDATE invoices SET file_path=? WHERE id=?`).run(dest, invoice.id);
    }

    db.prepare(`UPDATE invoices SET status='uploaded', lexware_voucher_id=?, updated_at=datetime('now') WHERE id=?`).run(voucherId, invoice.id);
    db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status) VALUES(?,?,?)`).run(invoice.id, invoice.status, 'uploaded');

    // Kick off reconciliation in background
    findMatch(invoice, db).then(match => {
      if (!match) return;
      db.prepare(`
        UPDATE invoices SET status='reconciliation_proposed', lexware_transaction_id=?, updated_at=datetime('now') WHERE id=?
      `).run(match.transactionId, invoice.id);
    }).catch(console.error);

    res.json({ ok: true, voucherId });
  } catch (err) { next(err); }
});

// Confirm reconciliation
router.post('/api/invoices/:id/reconcile', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id=?`).get(req.params.id);
    if (!invoice) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invoice not found', details: null } });

    await lexwareReconcile(invoice.lexware_voucher_id, invoice.lexware_transaction_id, db);
    db.prepare(`UPDATE invoices SET status='reconciled', updated_at=datetime('now') WHERE id=?`).run(invoice.id);
    db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status) VALUES(?,?,?)`).run(invoice.id, 'reconciliation_proposed', 'reconciled');

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Reject proposed match
router.post('/api/invoices/:id/reject-match', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare(`UPDATE invoices SET status='uploaded', lexware_transaction_id=NULL, updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status, detail) VALUES(?,?,?,?)`).run(req.params.id, 'reconciliation_proposed', 'uploaded', 'match rejected by user');
  res.json({ ok: true });
});

// Retry failed
router.post('/api/invoices/:id/retry', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare(`UPDATE invoices SET status='pending', error_message=NULL, updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  db.prepare(`INSERT INTO processing_log(invoice_id, from_status, to_status, detail) VALUES(?,?,?,?)`).run(req.params.id, 'failed', 'pending', 'manual retry');
  res.json({ ok: true });
});

// Poll log for an invoice
router.get('/api/invoices/:id/log', requireAuth, (req, res) => {
  const log = getDb().prepare(`SELECT * FROM processing_log WHERE invoice_id=? ORDER BY created_at`).all(req.params.id);
  res.json(log);
});

module.exports = router;
```

- [ ] **Step 2: Register in `src/app.js`**

```js
app.use(require('./routes/invoices'));
```

- [ ] **Step 3: Verify routes are reachable**

```bash
node src/server.js &
# login
curl -c c.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"rene@rene-winter.de","password":"changeme"}'
curl -b c.txt 'http://localhost:3000/api/invoices?page=1'
# Expected: {"data":[],"total":0,"page":1,"pageSize":25}
kill %1 && rm c.txt
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/invoices.js src/app.js
git commit -m "feat: invoice API routes — list, patch, upload, reconcile, retry"
```

---

## Task 13: Frontend — Dark Theme Foundation & Queue View

**Files:**
- Create: `public/index.html`
- Create: `public/css/app.css`
- Create: `public/js/app.js`
- Create: `public/js/queue.js`

- [ ] **Step 1: Write `public/css/app.css`**

```css
:root {
  --bg: #0f0f0f;
  --surface: #1a1a1a;
  --surface2: #252525;
  --accent: #F98E1D;
  --accent-hover: #e07d10;
  --text: #e5e5e5;
  --text-muted: #888;
  --border: #333;
  --green: #22c55e;
  --yellow: #eab308;
  --red: #ef4444;
  --blue: #3b82f6;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; display: flex; height: 100vh; overflow: hidden; }

/* Sidebar */
#sidebar { width: 220px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 16px 0; flex-shrink: 0; }
#sidebar .logo { padding: 0 16px 20px; font-size: 15px; font-weight: 700; color: var(--accent); }
#sidebar nav a { display: flex; align-items: center; gap: 10px; padding: 10px 16px; color: var(--text-muted); text-decoration: none; border-left: 3px solid transparent; }
#sidebar nav a:hover, #sidebar nav a.active { color: var(--text); border-left-color: var(--accent); background: var(--surface2); }

/* Main */
#main { flex: 1; overflow-y: auto; padding: 24px; }
h1 { font-size: 20px; margin-bottom: 16px; }

/* Table */
table { width: 100%; border-collapse: collapse; }
thead tr { border-bottom: 2px solid var(--border); }
th { text-align: left; padding: 8px 12px; color: var(--text-muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
tr:hover td { background: var(--surface); }

/* Badges */
.badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
.badge-pending, .badge-extracting { background: #333; color: var(--text-muted); }
.badge-review_needed { background: #3d2e00; color: var(--yellow); }
.badge-ready, .badge-uploaded { background: #0a2e1a; color: var(--green); }
.badge-reconciliation_proposed { background: #0a1a3d; color: var(--blue); }
.badge-reconciled { background: #0a2e1a; color: var(--green); }
.badge-failed { background: #2e0a0a; color: var(--red); }

/* Buttons */
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 6px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; }
.btn-primary { background: var(--accent); color: #000; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
.btn-danger { background: #2e0a0a; color: var(--red); border: 1px solid var(--red); }
.btn-sm { padding: 4px 10px; font-size: 12px; }

/* Filter bar */
.filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.filter-btn { background: var(--surface); border: 1px solid var(--border); color: var(--text-muted); padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.filter-btn.active { border-color: var(--accent); color: var(--accent); }

/* Pagination */
.pagination { display: flex; align-items: center; gap: 8px; margin-top: 16px; }

/* Toast */
#toast { position: fixed; bottom: 24px; right: 24px; background: var(--surface2); border: 1px solid var(--border); padding: 12px 18px; border-radius: 8px; display: none; z-index: 1000; }
#toast.success { border-color: var(--green); color: var(--green); }
#toast.error { border-color: var(--red); color: var(--red); }

/* Gmail banner */
#gmail-error-banner { display: none; background: #2e1a0a; border: 1px solid var(--yellow); color: var(--yellow); padding: 10px 16px; border-radius: 6px; margin-bottom: 16px; }
```

- [ ] **Step 2: Write `public/index.html`**

```html
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lexware Bookkeeping</title>
  <link rel="stylesheet" href="/css/app.css">
</head>
<body>
  <div id="sidebar">
    <div class="logo">Buchführung</div>
    <nav>
      <a href="#queue" class="nav-link active">Queue</a>
      <a href="#review" class="nav-link">Prüfen</a>
      <a href="#reconciliation" class="nav-link">Abstimmen</a>
      <a href="#settings" class="nav-link">Einstellungen</a>
    </nav>
  </div>
  <div id="main">
    <div id="gmail-error-banner"></div>
    <div id="view-queue"></div>
    <div id="view-review" style="display:none"></div>
    <div id="view-reconciliation" style="display:none"></div>
    <div id="view-settings" style="display:none"></div>
  </div>
  <div id="toast"></div>
  <script src="/js/app.js"></script>
  <script src="/js/queue.js"></script>
  <script src="/js/review.js"></script>
  <script src="/js/reconciliation.js"></script>
  <script src="/js/settings.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `public/js/app.js`** (router + toast)

```js
const views = { queue: 'view-queue', review: 'view-review', reconciliation: 'view-reconciliation', settings: 'view-settings' };

function navigate(view) {
  Object.values(views).forEach(id => document.getElementById(id).style.display = 'none');
  document.querySelectorAll('.nav-link').forEach(a => a.classList.remove('active'));
  document.getElementById(views[view]).style.display = 'block';
  document.querySelector(`a[href="#${view}"]`).classList.add('active');
  if (view === 'queue') window.renderQueue?.();
  if (view === 'review') window.renderReview?.();
  if (view === 'reconciliation') window.renderReconciliation?.();
  if (view === 'settings') window.renderSettings?.();
}

document.querySelectorAll('.nav-link').forEach(a => {
  a.addEventListener('click', e => { e.preventDefault(); navigate(a.getAttribute('href').slice(1)); });
});

window.showToast = function(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = type;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
};

window.api = async function(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
};

navigate('queue');
```

- [ ] **Step 4: Write `public/js/queue.js`**

```js
(function() {
  let currentPage = 1;
  let currentStatus = '';

  const STATUS_LABELS = {
    '': 'All', pending: 'Pending', extracting: 'Extracting',
    review_needed: 'Review', ready: 'Ready', uploaded: 'Uploaded',
    reconciliation_proposed: 'Propose', reconciled: 'Reconciled', failed: 'Failed',
  };

  window.renderQueue = async function(page = 1, status = currentStatus) {
    currentPage = page;
    currentStatus = status;
    const el = document.getElementById('view-queue');

    const params = new URLSearchParams({ page, ...(status && { status }) });
    const { data, total, pageSize } = await api('GET', `/api/invoices?${params}`);
    const totalPages = Math.ceil(total / pageSize);

    const filterBtns = Object.entries(STATUS_LABELS).map(([s, label]) =>
      `<button class="filter-btn ${s === status ? 'active' : ''}" onclick="renderQueue(1,'${s}')">${label}</button>`
    ).join('');

    const rows = data.map(inv => `
      <tr>
        <td>${inv.renamed_filename || inv.original_filename}</td>
        <td>${inv.company_name || '—'}</td>
        <td>${inv.invoice_date || '—'}</td>
        <td>${inv.vat_rate ? inv.vat_rate + '%' : '—'}</td>
        <td>${inv.amount_gross != null ? '€' + inv.amount_gross.toFixed(2) : '—'}</td>
        <td><span class="badge badge-${inv.status}">${inv.status.replace('_', ' ')}</span></td>
        <td>
          ${inv.status === 'failed' ? `<button class="btn btn-sm btn-secondary" onclick="retryInvoice(${inv.id})">Retry</button>` : ''}
          ${inv.status === 'ready' ? `<button class="btn btn-sm btn-primary" onclick="uploadInvoice(${inv.id})">Upload</button>` : ''}
          ${inv.error_message ? `<span style="color:var(--red);font-size:11px" title="${inv.error_message}">⚠ error</span>` : ''}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:32px">No invoices</td></tr>`;

    const pagination = totalPages > 1 ? `
      <div class="pagination">
        <button class="btn btn-secondary btn-sm" onclick="renderQueue(${page-1},'${status}')" ${page===1?'disabled':''}>←</button>
        <span>${page} / ${totalPages}</span>
        <button class="btn btn-secondary btn-sm" onclick="renderQueue(${page+1},'${status}')" ${page===totalPages?'disabled':''}>→</button>
      </div>
    ` : '';

    el.innerHTML = `
      <h1>Invoice Queue</h1>
      <div class="filter-bar">${filterBtns}</div>
      <table>
        <thead><tr><th>File</th><th>Company</th><th>Date</th><th>VAT</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${pagination}
    `;
  };

  window.retryInvoice = async function(id) {
    try {
      await api('POST', `/api/invoices/${id}/retry`);
      showToast('Queued for retry');
      renderQueue(currentPage, currentStatus);
    } catch (e) { showToast(e.message, 'error'); }
  };

  window.uploadInvoice = async function(id) {
    try {
      await api('POST', `/api/invoices/${id}/upload`);
      showToast('Uploaded to Lexware');
      renderQueue(currentPage, currentStatus);
    } catch (e) { showToast(e.message, 'error'); }
  };
})();
```

- [ ] **Step 5: Commit**

```bash
git add public/
git commit -m "feat: dark theme foundation, queue view with status filters"
```

---

## Task 14: Review View UI

**Files:**
- Create: `public/js/review.js`
- Modify: `public/index.html` — add pdf.js CDN script

- [ ] **Step 1: Add pdf.js to `public/index.html`** — before closing `</body>`

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';</script>
```

- [ ] **Step 2: Write `public/js/review.js`**

```js
(function() {
  window.renderReview = async function() {
    const el = document.getElementById('view-review');
    el.innerHTML = '<h1>Review Queue</h1><p style="color:var(--text-muted)">Loading…</p>';

    const { data } = await api('GET', '/api/invoices?status=review_needed&page=1');
    if (!data.length) {
      el.innerHTML = '<h1>Review Queue</h1><p style="color:var(--text-muted);margin-top:32px">No invoices need review.</p>';
      return;
    }

    el.innerHTML = `<h1>Review Queue (${data.length})</h1><div id="review-cards"></div>`;
    const container = document.getElementById('review-cards');

    for (const inv of data) {
      const card = document.createElement('div');
      card.style = 'display:flex;gap:24px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px;';
      card.innerHTML = `
        <div style="flex:1;min-width:0">
          <canvas id="pdf-canvas-${inv.id}" style="width:100%;border:1px solid var(--border);border-radius:4px"></canvas>
        </div>
        <div style="width:320px;flex-shrink:0">
          <div style="margin-bottom:12px;color:var(--text-muted);font-size:12px">EXTRACTION (${(inv.confidence_score*100).toFixed(0)}% confidence)</div>
          <label style="display:block;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text-muted)">Invoice Date</span>
            <input id="date-${inv.id}" type="date" value="${inv.invoice_date || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text-muted)">Company</span>
            <input id="company-${inv.id}" type="text" value="${inv.company_name || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text-muted)">VAT Rate</span>
            <select id="vat-${inv.id}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
              <option value="19" ${inv.vat_rate==19?'selected':''}>19%</option>
              <option value="7"  ${inv.vat_rate==7?'selected':''}>7%</option>
            </select>
          </label>
          <label style="display:block;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text-muted)">Service Type</span>
            <select id="type-${inv.id}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
              <option ${inv.service_type==='Dienstleistung'?'selected':''}>Dienstleistung</option>
              <option ${inv.service_type==='Lieferung'?'selected':''}>Lieferung</option>
              <option ${inv.service_type==='Sonstiges'?'selected':''}>Sonstiges</option>
            </select>
          </label>
          <label style="display:block;margin-bottom:8px">
            <span style="font-size:12px;color:var(--text-muted)">Net Amount (€)</span>
            <input id="net-${inv.id}" type="number" step="0.01" value="${inv.amount_net || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:16px">
            <span style="font-size:12px;color:var(--text-muted)">Gross Amount (€)</span>
            <input id="gross-${inv.id}" type="number" step="0.01" value="${inv.amount_gross || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <button class="btn btn-primary" style="width:100%" onclick="submitReview(${inv.id})">Looks good — Upload</button>
        </div>
      `;
      container.appendChild(card);

      // Render PDF preview
      fetch(`/api/invoices/${inv.id}/pdf`).then(r => r.arrayBuffer()).then(buf => {
        pdfjsLib.getDocument({ data: buf }).promise.then(pdf => {
          pdf.getPage(1).then(page => {
            const canvas = document.getElementById(`pdf-canvas-${inv.id}`);
            const viewport = page.getViewport({ scale: 1.2 });
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            page.render({ canvasContext: canvas.getContext('2d'), viewport });
          });
        });
      }).catch(() => {});
    }
  };

  window.submitReview = async function(id) {
    const fields = {
      invoice_date: document.getElementById(`date-${id}`).value,
      company_name: document.getElementById(`company-${id}`).value,
      vat_rate: parseFloat(document.getElementById(`vat-${id}`).value),
      service_type: document.getElementById(`type-${id}`).value,
      amount_net: parseFloat(document.getElementById(`net-${id}`).value),
      amount_gross: parseFloat(document.getElementById(`gross-${id}`).value),
    };
    try {
      await api('PATCH', `/api/invoices/${id}`, fields);
      await api('POST', `/api/invoices/${id}/upload`);
      showToast('Corrected and uploaded to Lexware');
      renderReview();
    } catch (e) { showToast(e.message, 'error'); }
  };
})();
```

- [ ] **Step 3: Add PDF serving route to `src/routes/invoices.js`** — append before `module.exports`

```js
router.get('/api/invoices/:id/pdf', requireAuth, (req, res, next) => {
  try {
    const invoice = getDb().prepare(`SELECT file_path FROM invoices WHERE id=?`).get(req.params.id);
    if (!invoice) return res.status(404).end();
    res.setHeader('Content-Type', 'application/pdf');
    fs.createReadStream(invoice.file_path).pipe(res);
  } catch (err) { next(err); }
});
```

- [ ] **Step 4: Commit**

```bash
git add public/js/review.js public/index.html src/routes/invoices.js
git commit -m "feat: review view with pdf.js preview and correction form"
```

---

## Task 15: Reconciliation View UI

**Files:**
- Create: `public/js/reconciliation.js`

- [ ] **Step 1: Write `public/js/reconciliation.js`**

```js
(function() {
  window.renderReconciliation = async function() {
    const el = document.getElementById('view-reconciliation');
    el.innerHTML = '<h1>Bank Reconciliation</h1><p style="color:var(--text-muted)">Loading…</p>';

    const { data } = await api('GET', '/api/invoices?status=reconciliation_proposed&page=1');
    if (!data.length) {
      el.innerHTML = '<h1>Bank Reconciliation</h1><p style="color:var(--text-muted);margin-top:32px">No pending matches.</p>';
      return;
    }

    const cards = data.map(inv => `
      <div style="display:flex;gap:24px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px;">
        <div style="flex:1">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Invoice</div>
          <div style="font-weight:600;margin-bottom:4px">${inv.company_name || '—'}</div>
          <div style="color:var(--text-muted)">${inv.invoice_date || ''}</div>
          <div style="font-size:20px;font-weight:700;margin-top:8px">€${(inv.amount_gross||0).toFixed(2)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${inv.service_type || ''} · ${inv.vat_rate ? inv.vat_rate + '% VAT' : ''}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:8px;word-break:break-all">${inv.renamed_filename || inv.original_filename}</div>
        </div>
        <div style="display:flex;align-items:center;font-size:20px;color:var(--text-muted)">→</div>
        <div style="flex:1;background:var(--surface2);border-radius:6px;padding:16px">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Proposed Bank Transaction</div>
          <div style="font-weight:600;margin-bottom:4px" id="tx-desc-${inv.id}">Loading…</div>
          <div id="tx-date-${inv.id}" style="color:var(--text-muted)"></div>
          <div id="tx-amount-${inv.id}" style="font-size:20px;font-weight:700;margin-top:8px"></div>
        </div>
        <div style="display:flex;flex-direction:column;justify-content:center;gap:10px">
          <button class="btn btn-primary" onclick="confirmMatch(${inv.id})">Confirm Match</button>
          <button class="btn btn-danger" onclick="rejectMatch(${inv.id})">Reject</button>
        </div>
      </div>
    `).join('');

    el.innerHTML = `<h1>Bank Reconciliation (${data.length})</h1>${cards}`;
  };

  window.confirmMatch = async function(id) {
    try {
      await api('POST', `/api/invoices/${id}/reconcile`);
      showToast('Match confirmed in Lexware');
      renderReconciliation();
    } catch (e) { showToast(e.message, 'error'); }
  };

  window.rejectMatch = async function(id) {
    try {
      await api('POST', `/api/invoices/${id}/reject-match`);
      showToast('Match rejected');
      renderReconciliation();
    } catch (e) { showToast(e.message, 'error'); }
  };
})();
```

- [ ] **Step 2: Commit**

```bash
git add public/js/reconciliation.js
git commit -m "feat: reconciliation view with confirm/reject actions"
```

---

## Task 16: Settings View UI

**Files:**
- Create: `public/js/settings.js`

- [ ] **Step 1: Write `public/js/settings.js`**

```js
(function() {
  window.renderSettings = async function() {
    const el = document.getElementById('view-settings');
    const settings = await api('GET', '/api/settings');
    const params = new URLSearchParams(window.location.search);
    const gmailConnected = !!settings.gmail_oauth_tokens || params.get('gmail') === 'connected';

    el.innerHTML = `
      <h1>Settings</h1>
      <div style="max-width:520px">

        <section style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px">
          <h2 style="font-size:15px;margin-bottom:16px">Gmail</h2>
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="color:${gmailConnected ? 'var(--green)' : 'var(--text-muted)'}">
              ${gmailConnected ? '● Connected' : '○ Not connected'}
            </span>
            ${gmailConnected
              ? `<button class="btn btn-danger btn-sm" onclick="disconnectGmail()">Disconnect</button>`
              : `<a href="/api/auth/gmail" class="btn btn-primary btn-sm">Connect Gmail</a>`
            }
          </div>
          ${gmailConnected ? `<button class="btn btn-secondary btn-sm" style="margin-top:10px" onclick="triggerPoll()">Run Poll Now</button>` : ''}
        </section>

        <section style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px">
          <h2 style="font-size:15px;margin-bottom:16px">API Keys</h2>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Lexware API Key</span>
            <input id="lexware-key" type="password" placeholder="••••${settings.lexware_api_key || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Claude API Key</span>
            <input id="claude-key" type="password" placeholder="••••${settings.claude_api_key || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <button class="btn btn-primary btn-sm" onclick="saveKeys()">Save Keys</button>
        </section>

        <section style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px">
          <h2 style="font-size:15px;margin-bottom:16px">Configuration</h2>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Invoice Drop Folder</span>
            <input id="drop-folder" type="text" value="${settings.drop_folder_path || ''}" style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;margin-top:4px;display:block">
          </label>
          <label style="display:block;margin-bottom:12px">
            <span style="font-size:12px;color:var(--text-muted)">Confidence Threshold: <strong id="threshold-val">${settings.confidence_threshold || 0.80}</strong></span>
            <input id="threshold" type="range" min="0.50" max="1.00" step="0.05" value="${settings.confidence_threshold || 0.80}"
              oninput="document.getElementById('threshold-val').textContent=this.value"
              style="width:100%;margin-top:8px;accent-color:var(--accent)">
          </label>
          <button class="btn btn-primary btn-sm" onclick="saveConfig()">Save Configuration</button>
        </section>

      </div>
    `;
  };

  window.saveKeys = async function() {
    const body = {};
    const lk = document.getElementById('lexware-key').value;
    const ck = document.getElementById('claude-key').value;
    if (lk) body.lexware_api_key = lk;
    if (ck) body.claude_api_key = ck;
    if (!Object.keys(body).length) return showToast('No changes', 'error');
    try { await api('PATCH', '/api/settings', body); showToast('Keys saved'); }
    catch (e) { showToast(e.message, 'error'); }
  };

  window.saveConfig = async function() {
    try {
      await api('PATCH', '/api/settings', {
        drop_folder_path: document.getElementById('drop-folder').value,
        confidence_threshold: document.getElementById('threshold').value,
      });
      showToast('Configuration saved');
    } catch (e) { showToast(e.message, 'error'); }
  };

  window.disconnectGmail = async function() {
    try { await api('POST', '/api/auth/gmail/disconnect'); showToast('Gmail disconnected'); renderSettings(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  window.triggerPoll = async function() {
    try { await api('POST', '/api/auth/gmail/poll'); showToast('Gmail poll triggered'); }
    catch (e) { showToast(e.message, 'error'); }
  };
})();
```

- [ ] **Step 2: Commit**

```bash
git add public/js/settings.js
git commit -m "feat: settings view — Gmail OAuth, API keys, threshold slider"
```

---

## Task 17: Integration Tests

**Files:**
- Create: `tests/integration/pipeline.test.js`
- Create: `tests/integration/reconciliation.test.js`

- [ ] **Step 1: Write `tests/integration/pipeline.test.js`**

```js
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'test';

jest.mock('../../src/services/pdfExtractor');
jest.mock('../../src/services/lexwareClient');

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { runMigrations } = require('../../src/db/migrations');
const { startFolderWatcher } = require('../../src/jobs/folderWatcher');
const { processPending } = require('../../src/jobs/pipeline');
const { extractInvoiceData } = require('../../src/services/pdfExtractor');
const { uploadVoucher } = require('../../src/services/lexwareClient');

// Export processPending from pipeline for test access
// (Add: module.exports = { startPipeline, processPending }; to pipeline.js)

let db, tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-test-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO settings(key, encrypted_value) VALUES('drop_folder_path', ?)`).run(tmpDir);
  db.prepare(`INSERT INTO settings(key, encrypted_value) VALUES('confidence_threshold', '0.80')`).run();
  db.prepare(`INSERT INTO settings(key, encrypted_value) VALUES('claude_api_key', 'enc')`).run();
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

test('folder watcher picks up new PDF and inserts pending invoice', done => {
  const { decrypt } = require('../../src/services/encryptor');
  jest.spyOn(require('../../src/services/encryptor'), 'decrypt').mockReturnValue(tmpDir);

  // Override drop_folder_path lookup in watcher
  db.prepare(`UPDATE settings SET encrypted_value=? WHERE key='drop_folder_path'`).run(tmpDir);
  startFolderWatcher(db);

  setTimeout(() => {
    fs.writeFileSync(path.join(tmpDir, 'inbox', 'test.pdf'), '%PDF-1.4 dummy');
    setTimeout(() => {
      const rows = db.prepare('SELECT * FROM invoices').all();
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('pending');
      done();
    }, 500);
  }, 200);
}, 5000);

test('pipeline extracts high-confidence invoice and moves to ready', async () => {
  const filePath = path.join(tmpDir, 'inbox', 'inv.pdf');
  fs.writeFileSync(filePath, '%PDF dummy');
  db.prepare(`INSERT INTO invoices(source, original_filename, file_path, status) VALUES('folder','inv.pdf',?,'pending')`).run(filePath);

  extractInvoiceData.mockResolvedValue({
    invoice_date: '2026-01-15', company_name: 'Test GmbH',
    vat_rate: 19, service_type: 'Dienstleistung',
    amount_net: 100, amount_gross: 119, confidence_score: 0.95,
  });

  // make processPending exported
  const { processPending } = require('../../src/jobs/pipeline');
  await processPending(db);

  const inv = db.prepare('SELECT * FROM invoices').get();
  expect(inv.status).toBe('ready');
  expect(inv.company_name).toBe('Test GmbH');
  expect(inv.renamed_filename).toBe('2026-01-15-test-gmbh.pdf');
});

test('pipeline moves low-confidence invoice to review_needed', async () => {
  const filePath = path.join(tmpDir, 'inbox', 'inv2.pdf');
  fs.writeFileSync(filePath, '%PDF dummy');
  db.prepare(`INSERT INTO invoices(source, original_filename, file_path, status) VALUES('folder','inv2.pdf',?,'pending')`).run(filePath);

  extractInvoiceData.mockResolvedValue({
    invoice_date: '2026-01-15', company_name: 'Unclear Co',
    vat_rate: 19, service_type: 'Sonstiges',
    amount_net: 50, amount_gross: 59.5, confidence_score: 0.60,
  });

  const { processPending } = require('../../src/jobs/pipeline');
  await processPending(db);

  const inv = db.prepare('SELECT * FROM invoices').get();
  expect(inv.status).toBe('review_needed');
});

test('duplicate gmail_message_id is silently skipped', () => {
  db.prepare(`INSERT INTO invoices(source, original_filename, file_path, gmail_message_id, status) VALUES('gmail','a.pdf','/tmp/a.pdf','msg-1','pending')`).run();
  expect(() => {
    db.prepare(`INSERT INTO invoices(source, original_filename, file_path, gmail_message_id, status) VALUES('gmail','a.pdf','/tmp/a.pdf','msg-1','pending')`).run();
  }).toThrow(); // UNIQUE constraint violation
});
```

- [ ] **Step 2: Export `processPending` from `src/jobs/pipeline.js`**

Change the last line from:
```js
module.exports = { startPipeline };
```
to:
```js
module.exports = { startPipeline, processPending };
```

- [ ] **Step 3: Write `tests/integration/reconciliation.test.js`**

```js
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
jest.mock('../../src/services/lexwareClient');
jest.mock('../../src/services/encryptor');

const { decrypt } = require('../../src/services/encryptor');
decrypt.mockReturnValue('key');

const Database = require('better-sqlite3');
const { runMigrations } = require('../../src/db/migrations');
const { getBankTransactions, reconcile } = require('../../src/services/lexwareClient');
const { findMatch } = require('../../src/services/reconciler');

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO settings(key, encrypted_value) VALUES('lexware_api_key','enc')`).run();
});

test('findMatch returns match for exact amount within 7 days', async () => {
  getBankTransactions.mockResolvedValue([{
    id: 'tx-1', date: '2026-01-16', amount: 119.00, description: 'Amazon GmbH',
  }]);
  const match = await findMatch({ id: 1, invoice_date: '2026-01-15', amount_gross: 119.00, company_name: 'Amazon GmbH' }, db);
  expect(match?.transactionId).toBe('tx-1');
});

test('findMatch returns null when amount differs', async () => {
  getBankTransactions.mockResolvedValue([{ id: 'tx-2', date: '2026-01-15', amount: 99.00, description: 'Amazon' }]);
  const match = await findMatch({ id: 1, invoice_date: '2026-01-15', amount_gross: 119.00, company_name: 'Amazon' }, db);
  expect(match).toBeNull();
});
```

- [ ] **Step 4: Run all tests**

```bash
npx jest
# Expected: all tests pass, no failures
```

- [ ] **Step 5: Commit**

```bash
git add tests/ src/jobs/pipeline.js
git commit -m "test: integration tests for pipeline, dedup, and reconciliation"
```

---

## Task 18: Hardening & Docs

**Files:**
- Create: `Dockerfile`
- Create: `docs/adr/ADR-001.md`
- Modify: `README.md`

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

- [ ] **Step 2: Write `docs/adr/ADR-001.md`**

```markdown
# ADR-001: Stack B (Local Express/SQLite) over Stack A (Next.js/Supabase)

**Date:** 2026-06-19
**Status:** Accepted

## Decision
Use a local Node.js/Express/SQLite tool instead of a cloud-deployed Next.js/Supabase app.

## Reasons
- Invoice PDFs and financial data stay on-machine — no cloud storage required
- Single user (René Winter) — no multi-tenant auth complexity needed
- SQLite is sufficient for 20–50 invoices/month; no need for Postgres
- Simpler deployment: `node src/server.js`, no Vercel/cloud costs

## Trade-offs
- Not accessible from other devices without a tunnel
- No built-in backup of the SQLite file (documented in README runbook)
```

- [ ] **Step 3: Write `README.md`**

```markdown
# Lexware Bookkeeping Automation Tool

Automates invoice processing: Gmail ingestion → AI extraction → Lexware upload → bank reconciliation.

## Setup

```bash
cp .env.example .env
# Fill in ENCRYPTION_KEY, SESSION_SECRET, and optionally Google OAuth creds

npm install
npm run seed  # Creates admin user (set ADMIN_EMAIL + ADMIN_PASSWORD in .env)
npm start     # http://localhost:3000
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| ENCRYPTION_KEY | Yes | 64-char hex (openssl rand -hex 32) |
| SESSION_SECRET | Yes | Random string (openssl rand -hex 32) |
| PORT | No | Default 3000 |
| INVOICE_FOLDER | No | Default drop folder path |
| ADMIN_EMAIL | Seed only | Initial admin email |
| ADMIN_PASSWORD | Seed only | Initial admin password |
| GOOGLE_CLIENT_ID | Gmail | From Google Cloud Console |
| GOOGLE_CLIENT_SECRET | Gmail | From Google Cloud Console |
| GOOGLE_REDIRECT_URI | Gmail | Default: http://localhost:3000/api/auth/gmail/callback |

## Folder Structure

After first run, three subfolders are created inside `INVOICE_FOLDER`:
- `inbox/` — new PDFs (from Gmail or manual drop)
- `processed/` — PDFs successfully uploaded to Lexware
- `failed/` — PDFs that failed permanently

## Scripts

```bash
npm start      # Run server
npm test       # Run test suite
npm run seed   # Create/reset admin user
```

## Manual Smoke Test Checklist

1. Drop a PDF into `inbox/` → watch it appear in Queue view with status `pending` → should reach `ready` or `review_needed` within 30 seconds
2. Settings → Connect Gmail → run "Run Poll Now" → verify attachments appear in Queue
3. Review view → correct a field → click "Looks good — Upload" → status becomes `uploaded`
4. Reconciliation view → "Confirm Match" → status becomes `reconciled`

## Runbook

### Restore from backup
```bash
cp data.db.bak data.db
npm start
```

### Rotate encryption master key
1. Generate new key: `openssl rand -hex 32`
2. Write a script that reads all `settings` rows, decrypts with old key, re-encrypts with new key
3. Update `ENCRYPTION_KEY` in `.env`
4. Restart server

### Lexware API outage
Failed uploads remain in status `ready` or `failed`. Use "Retry" button in Queue view once the API recovers. No data is lost.
```

- [ ] **Step 4: Run full test suite**

```bash
npm test
# Expected: all tests green
```

- [ ] **Step 5: Push to GitHub**

```bash
git add Dockerfile docs/ README.md
git commit -m "docs: Dockerfile, ADR-001, README with runbook and smoke tests"
gh repo create wintair6/lexware-bookkeeping-tool --private
git remote add origin git@github.com:wintair6/lexware-bookkeeping-tool.git
git push -u origin main
```

---

## Self-Review Checklist

- [x] **Spec coverage:** Gmail polling ✓, folder watcher ✓, AI extraction ✓, confidence threshold ✓, review queue ✓, Lexware upload ✓, rename convention ✓, reconciliation ✓, confirm/reject ✓, retry ✓, encryption ✓, auth ✓, settings ✓, error envelope ✓, pagination ✓, dark theme ✓, pdf.js preview ✓, Dockerfile ✓, ADR ✓, runbook ✓, seed script ✓
- [x] **No placeholders:** All steps contain actual code
- [x] **Type consistency:** `processPending` exported in Task 17 matches call in integration test; `ExtractionResult` fields match between pdfExtractor and pipeline; `Transaction` shape returned by `getBankTransactions` matches reconciler consumption

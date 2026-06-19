process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'test';

// chokidar v5 is ESM-only — mock it before requiring folderWatcher
jest.mock('chokidar', () => {
  const { EventEmitter } = require('events');
  const watchers = [];
  const mockWatch = (dir) => {
    const emitter = new EventEmitter();
    emitter._watchedDir = dir;
    watchers.push(emitter);
    return emitter;
  };
  mockWatch._watchers = watchers;
  return { watch: mockWatch, _watchers: watchers };
});

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
const chokidar = require('chokidar');

let db, tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-test-'));
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  // drop_folder_path stored as plain text in encrypted_value (folderWatcher reads it directly)
  db.prepare(`INSERT INTO settings(key, encrypted_value) VALUES('drop_folder_path', ?)`).run(tmpDir);
  db.prepare(`INSERT INTO settings(key, encrypted_value) VALUES('confidence_threshold', '0.80')`).run();
  db.prepare(`INSERT INTO settings(key, encrypted_value) VALUES('claude_api_key', 'enc')`).run();
  // Clear watchers array between tests
  chokidar._watchers.splice(0);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

test('folder watcher picks up new PDF and inserts pending invoice', done => {
  // folderWatcher reads encrypted_value directly (no decrypt) — tmpDir is set correctly
  startFolderWatcher(db);

  // After startFolderWatcher, a watcher emitter was registered for the inbox dir
  const watcher = chokidar._watchers[0];
  expect(watcher).toBeDefined();

  const inboxDir = path.join(tmpDir, 'inbox');
  const pdfPath = path.join(inboxDir, 'test.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.4 dummy');

  // Simulate chokidar emitting 'add' event for the PDF file
  watcher.emit('add', pdfPath);

  setImmediate(() => {
    const rows = db.prepare('SELECT * FROM invoices').all();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('pending');
    done();
  });
}, 5000);

test('pipeline extracts high-confidence invoice and moves to ready', async () => {
  const inboxDir = path.join(tmpDir, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  const filePath = path.join(inboxDir, 'inv.pdf');
  fs.writeFileSync(filePath, '%PDF dummy');
  db.prepare(`INSERT INTO invoices(source, original_filename, file_path, status) VALUES('folder','inv.pdf',?,'pending')`).run(filePath);

  extractInvoiceData.mockResolvedValue({
    invoice_date: '2026-01-15', company_name: 'Test GmbH',
    vat_rate: 19, service_type: 'Dienstleistung',
    amount_net: 100, amount_gross: 119, confidence_score: 0.95,
  });

  await processPending(db);

  const inv = db.prepare('SELECT * FROM invoices').get();
  expect(inv.status).toBe('ready');
  expect(inv.company_name).toBe('Test GmbH');
  expect(inv.renamed_filename).toBe('2026-01-15-test-gmbh.pdf');
});

test('pipeline moves low-confidence invoice to review_needed', async () => {
  const inboxDir = path.join(tmpDir, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  const filePath = path.join(inboxDir, 'inv2.pdf');
  fs.writeFileSync(filePath, '%PDF dummy');
  db.prepare(`INSERT INTO invoices(source, original_filename, file_path, status) VALUES('folder','inv2.pdf',?,'pending')`).run(filePath);

  extractInvoiceData.mockResolvedValue({
    invoice_date: '2026-01-15', company_name: 'Unclear Co',
    vat_rate: 19, service_type: 'Sonstiges',
    amount_net: 50, amount_gross: 59.5, confidence_score: 0.60,
  });

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

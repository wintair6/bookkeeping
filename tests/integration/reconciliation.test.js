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

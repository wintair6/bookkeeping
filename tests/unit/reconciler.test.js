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
    id: 'tx-1', date: '2026-01-16', amount: 119.00, description: 'Amazon GmbH',
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

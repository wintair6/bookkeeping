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

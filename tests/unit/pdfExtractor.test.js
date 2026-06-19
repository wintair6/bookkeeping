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

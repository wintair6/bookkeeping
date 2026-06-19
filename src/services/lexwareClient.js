'use strict';

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
    throw Object.assign(
      new Error(`Lexware ${res.status}: ${body.message || 'Unknown error'}`),
      { status: res.status }
    );
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Lexware API timeout after 15s');
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(err.code) && retries > 0) {
      const delay = (MAX_RETRIES - retries + 1) * 2000;
      await new Promise(r => setTimeout(r, delay));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw err;
  }
}

async function uploadVoucher(invoiceData, pdfBuffer, db) {
  const apiKey = getApiKey(db);

  const voucherPayload = {
    type: 'purchaseinvoice',
    voucherDate: invoiceData.invoice_date + 'T00:00:00.000+01:00',
    supplierName: invoiceData.company_name,
    lineItems: [
      {
        amount: {
          grossValue: invoiceData.amount_gross,
          taxRatePercent: invoiceData.vat_rate,
        },
        categoryId: invoiceData.service_type === 'Dienstleistung' ? '8' : '1',
      },
    ],
    remark: 'Auto-imported via bookkeeping tool',
  };

  const form = new FormData();
  form.append(
    'voucherMetadata',
    new Blob([JSON.stringify(voucherPayload)], { type: 'application/json' })
  );
  if (pdfBuffer) {
    form.append(
      'file',
      new Blob([pdfBuffer], { type: 'application/pdf' }),
      'invoice.pdf'
    );
  }

  const res = await fetchWithRetry(`${BASE_URL}/vouchers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const { id: voucherId } = await res.json();
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
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'voucher', id: voucherId }),
  });
}

module.exports = { uploadVoucher, getBankTransactions, reconcile };

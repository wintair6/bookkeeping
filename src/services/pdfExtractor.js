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
  let text = '';
  try {
    const buffer = fs.readFileSync(filePath);
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

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

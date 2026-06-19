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

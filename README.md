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

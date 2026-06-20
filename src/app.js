require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const errorHandler = require('./middleware/errorHandler');

function createApp() {
  if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET env var is required');
  if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY env var is required');

  const app = express();

  app.use(helmet({
    // HSTS disabled: tool runs on HTTP-only localhost, HSTS would force Safari
    // to use HTTPS permanently (365 days) breaking all CSS/JS loading
    strictTransportSecurity: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'https:', 'data:'],
      },
    },
  }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, '..') }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
  }));

  app.use(require('./routes/health'));
  app.use(require('./routes/settings'));
  app.use(require('./routes/invoices'));

  const bcrypt = require('bcryptjs');
  const { getDb } = require('./db/connection');

  app.get('/api/auth/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Not authenticated', details: null } });
    const user = getDb().prepare('SELECT id, email FROM users WHERE id=?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Session invalid', details: null } });
    res.json({ user: { email: user.email } });
  });

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'email and password required', details: null } });
      const user = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password', details: null } });
      }
      req.session.userId = user.id;
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };

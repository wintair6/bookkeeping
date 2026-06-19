require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const errorHandler = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
      },
    },
  }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: '.' }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
  }));

  app.use(require('./routes/health'));
  // Additional routes registered in later tasks

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };

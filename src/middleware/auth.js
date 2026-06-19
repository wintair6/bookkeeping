function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated', details: null } });
}

module.exports = { requireAuth };

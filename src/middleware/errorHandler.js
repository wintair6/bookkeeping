module.exports = function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  console.error(`[${code}] ${err.message}`, err.details || '');
  res.status(status).json({ error: { code, message: err.message, details: err.details || null } });
};

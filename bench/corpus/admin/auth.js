'use strict';

const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;

function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    const claims = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    req.user = { id: claims.sub, role: claims.role };
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    return next();
  });
}

module.exports = { requireUser, requireAdmin };

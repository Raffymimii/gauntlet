const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
const ISSUER = 'example-app';

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, SECRET, { issuer: ISSUER, expiresIn: '1h' });
}

function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  const claims = jwt.decode(token);
  if (!claims || claims.iss !== ISSUER) {
    return res.status(401).json({ error: 'invalid token' });
  }
  req.user = { id: claims.sub, role: claims.role };
  next();
}

function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
  });
}

module.exports = { issueToken, requireUser, requireAdmin };

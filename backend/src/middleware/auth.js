const jwt = require('jsonwebtoken');
const pool = require('../config/db');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = header.slice(7);
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// For mobile (customer) app — token contains customer_id. Also checks the
// mobile_users row still exists and is active on every request, so a token
// issued before an account was deleted (or is still pending approval) stops
// working immediately instead of remaining valid until it naturally expires.
async function requireCustomerAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = header.slice(7);
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (!decoded.customer_id) {
    return res.status(403).json({ error: 'Customer token required' });
  }

  const result = await pool.query('SELECT active FROM mobile_users WHERE id = $1', [decoded.user_id]);
  if (!result.rows.length) {
    return res.status(401).json({ error: 'Account no longer exists' });
  }
  if (!result.rows[0].active) {
    return res.status(403).json({ error: 'Your account is pending admin approval' });
  }

  req.user = decoded;
  next();
}

module.exports = { requireAuth, requireCustomerAuth };

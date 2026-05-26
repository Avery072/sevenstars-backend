const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// POST /api/auth/customer-login
async function customerLogin(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  const result = await pool.query(
    `SELECT mu.*, c.company_name, c.active AS company_active
     FROM mobile_users mu
     JOIN customers c ON c.id = mu.customer_id
     WHERE mu.email = $1`,
    [email]
  );

  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!user.active || !user.company_active) {
    return res.status(403).json({ error: 'Your account is pending admin approval' });
  }

  const token = jwt.sign(
    { user_id: user.id, customer_id: user.customer_id, company_name: user.company_name },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({ token, company_name: user.company_name, name: user.name, customer_id: user.customer_id });
}

// POST /api/auth/customer-signup
async function customerSignup(req, res) {
  const { company_name, address, phone, first_name, last_name, email, password, resale_certificate_number } = req.body;

  if (!company_name || !email || !password) {
    return res.status(400).json({ error: 'company_name, email, and password are required' });
  }

  // Check email not already taken
  const existing = await pool.query('SELECT id FROM mobile_users WHERE email = $1', [email]);
  if (existing.rows.length) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create pending customer (active = false until admin approves)
    const customerResult = await client.query(
      `INSERT INTO customers (company_name, first_name, last_name, phone, address, resale_certificate_number, active)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE) RETURNING id`,
      [company_name, first_name || null, last_name || null, phone || null, address || null, resale_certificate_number || null]
    );
    const customer_id = customerResult.rows[0].id;

    // Create mobile user (also inactive)
    const hash = await bcrypt.hash(password, 10);
    await client.query(
      `INSERT INTO mobile_users (customer_id, email, password_hash, name, active)
       VALUES ($1, $2, $3, $4, FALSE)`,
      [customer_id, email, hash, [first_name, last_name].filter(Boolean).join(' ') || null]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Signup request submitted. You will be notified once approved.' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// GET /api/auth/customer-me  — returns current user info from token
async function customerMe(req, res) {
  const result = await pool.query(
    `SELECT mu.id, mu.email, mu.name, c.company_name, c.id AS customer_id,
            c.salmon_cut, c.skin_off, c.scale, c.pbo, c.hg, c.language_pref
     FROM mobile_users mu
     JOIN customers c ON c.id = mu.customer_id
     WHERE mu.id = $1`,
    [req.user.user_id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(result.rows[0]);
}

module.exports = { customerLogin, customerSignup, customerMe };

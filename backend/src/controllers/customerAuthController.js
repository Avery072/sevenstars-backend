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
    `SELECT mu.*, c.company_name, c.active AS company_active, c.salmon_cut
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
    { user_id: user.id, customer_id: user.customer_id, company_name: user.company_name, is_main: user.is_main },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  // Show the quiz only if this user hasn't completed it AND the company has no
  // salmon preference yet. A pre-configured/migrated company counts as done.
  const quiz_completed = user.quiz_completed || user.salmon_cut !== null;

  res.json({ token, company_name: user.company_name, name: user.name, customer_id: user.customer_id, is_main: user.is_main, quiz_completed });
}

// GET /api/auth/check-company?name=X
async function checkCompany(req, res) {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = await pool.query(
    'SELECT id FROM customers WHERE LOWER(company_name) = LOWER($1) AND active = TRUE',
    [name.trim()]
  );
  if (result.rows.length > 0) {
    res.json({ exists: true, customer_id: result.rows[0].id });
  } else {
    res.json({ exists: false });
  }
}

// POST /api/auth/customer-signup
// Two modes:
//   New company:      { company_name, first_name, last_name, email, password, phone, address, resale_certificate_number }
//   Joining existing: { customer_id, first_name, last_name, email, password }
async function customerSignup(req, res) {
  const { customer_id, company_name, address, phone, first_name, last_name, email, password,
          resale_certificate_number, resale_number,
          salmon_cut, skin_off, scale, pbo, hg } = req.body;
  const resaleCert = resale_certificate_number || resale_number || null;
  const joiningExisting = !!customer_id;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (!joiningExisting && !company_name) {
    return res.status(400).json({ error: 'company_name is required for new company signup' });
  }

  const existing = await pool.query('SELECT id FROM mobile_users WHERE email = $1', [email]);
  if (existing.rows.length) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);

    if (joiningExisting) {
      // Verify the company is active
      const company = await client.query('SELECT id FROM customers WHERE id = $1 AND active = TRUE', [customer_id]);
      if (!company.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Company not found or not yet approved' });
      }
      // Sub-user: is_main=FALSE, active=FALSE — main user must approve
      await client.query(
        `INSERT INTO mobile_users (customer_id, email, password_hash, name, active, is_main)
         VALUES ($1, $2, $3, $4, FALSE, FALSE)`,
        [customer_id, email, hash, [first_name, last_name].filter(Boolean).join(' ') || null]
      );
      await client.query('COMMIT');
      res.status(201).json({ message: 'Request submitted. The main user for your company must approve your account.' });
    } else {
      // New company: create customer row + main user
      const customerResult = await client.query(
        `INSERT INTO customers (company_name, first_name, last_name, phone, address, resale_certificate_number, active,
                                salmon_cut, skin_off, scale, pbo, hg)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, $8, $9, $10, $11) RETURNING id`,
        [company_name, first_name || null, last_name || null, phone || null, address || null, resaleCert,
         salmon_cut || null, skin_off ?? false, scale ?? false, pbo ?? false, hg ?? false]
      );
      const new_customer_id = customerResult.rows[0].id;
      await client.query(
        `INSERT INTO mobile_users (customer_id, email, password_hash, name, active, is_main)
         VALUES ($1, $2, $3, $4, FALSE, TRUE)`,
        [new_customer_id, email, hash, [first_name, last_name].filter(Boolean).join(' ') || null]
      );
      await client.query('COMMIT');
      res.status(201).json({ message: 'Signup request submitted. You will be notified once approved.' });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505' && err.constraint?.includes('email')) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    throw err;
  } finally {
    client.release();
  }
}

// GET /api/auth/customer-me  — returns current user info from token
async function customerMe(req, res) {
  const result = await pool.query(
    `SELECT mu.id, mu.email, mu.name, mu.is_main, c.company_name, c.id AS customer_id,
            c.salmon_cut, c.skin_off, c.scale, c.pbo, c.hg, c.language_pref
     FROM mobile_users mu
     JOIN customers c ON c.id = mu.customer_id
     WHERE mu.id = $1`,
    [req.user.user_id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(result.rows[0]);
}

module.exports = { customerLogin, customerSignup, customerMe, checkCompany };

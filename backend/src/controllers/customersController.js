const pool = require('../config/db');

async function listCustomers(req, res) {
  const result = await pool.query(
    'SELECT * FROM customers WHERE active = TRUE ORDER BY company_name'
  );
  res.json(result.rows);
}

async function getCustomer(req, res) {
  const { id } = req.params;
  const result = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Customer not found' });
  res.json(result.rows[0]);
}

async function createCustomer(req, res) {
  const {
    company_name, first_name, last_name, phone, email,
    language_pref, ordering_method, salmon_cut,
    skin_off, scale, pbo, hg, notes,
  } = req.body;

  if (!company_name) return res.status(400).json({ error: 'company_name is required' });

  const result = await pool.query(
    `INSERT INTO customers
       (company_name, first_name, last_name, phone, email,
        language_pref, ordering_method, salmon_cut,
        skin_off, scale, pbo, hg, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [company_name, first_name, last_name, phone, email,
      language_pref || 'English', ordering_method || 'Mobile App',
      salmon_cut, skin_off ?? false, scale ?? false, pbo ?? false, hg ?? false, notes]
  );

  res.status(201).json(result.rows[0]);
}

async function updateCustomer(req, res) {
  const { id } = req.params;
  const fields = req.body;

  const allowed = [
    'company_name', 'first_name', 'last_name', 'phone', 'email',
    'language_pref', 'ordering_method', 'salmon_cut',
    'skin_off', 'scale', 'pbo', 'hg', 'notes', 'active',
  ];

  const sets = [];
  const values = [];
  let idx = 1;

  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = $${idx++}`);
      values.push(fields[key]);
    }
  }

  if (!sets.length) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(id);
  const result = await pool.query(
    `UPDATE customers SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Customer not found' });
  res.json(result.rows[0]);
}

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer };

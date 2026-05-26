const pool = require('../config/db');

async function listPending(req, res) {
  const result = await pool.query(
    `SELECT c.id, c.company_name, c.first_name, c.last_name,
            c.phone, c.address, c.resale_certificate_number, c.created_at,
            mu.email, mu.name AS user_name
     FROM customers c
     LEFT JOIN mobile_users mu ON mu.customer_id = c.id
     WHERE c.active = FALSE
     ORDER BY c.created_at DESC`
  );
  res.json(result.rows);
}

async function approveCustomer(req, res) {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'UPDATE customers SET active = TRUE WHERE id = $1 AND active = FALSE RETURNING id, company_name',
      [id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending customer not found' });
    }
    await client.query('UPDATE mobile_users SET active = TRUE WHERE customer_id = $1', [id]);
    await client.query('COMMIT');
    res.json({ message: `${result.rows[0].company_name} approved`, customer_id: result.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function rejectCustomer(req, res) {
  const { id } = req.params;
  const result = await pool.query(
    'DELETE FROM customers WHERE id = $1 AND active = FALSE RETURNING company_name',
    [id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Pending customer not found' });
  res.json({ message: `${result.rows[0].company_name} rejected and removed` });
}

module.exports = { listPending, approveCustomer, rejectCustomer };

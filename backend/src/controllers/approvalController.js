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

// Sub-user approvals (mobile_users with active=FALSE, is_main=FALSE, under an already-active company)
async function listPendingSubUsers(req, res) {
  const result = await pool.query(
    `SELECT mu.id, mu.name, mu.email, mu.created_at,
            c.id AS customer_id, c.company_name
     FROM mobile_users mu
     JOIN customers c ON c.id = mu.customer_id
     WHERE mu.active = FALSE AND mu.is_main = FALSE AND c.active = TRUE
     ORDER BY mu.created_at DESC`
  );
  res.json(result.rows);
}

async function approveSubUser(req, res) {
  const { id } = req.params;
  const result = await pool.query(
    `UPDATE mobile_users SET active = TRUE
     WHERE id = $1 AND is_main = FALSE AND active = FALSE
     RETURNING id, name, email`,
    [id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Pending sub-user not found' });
  res.json({ message: `${result.rows[0].name || result.rows[0].email} approved` });
}

async function rejectSubUser(req, res) {
  const { id } = req.params;
  const result = await pool.query(
    `DELETE FROM mobile_users
     WHERE id = $1 AND is_main = FALSE AND active = FALSE
     RETURNING name, email`,
    [id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Pending sub-user not found' });
  res.json({ message: `${result.rows[0].name || result.rows[0].email} rejected` });
}

// All companies with their mobile users — primary first, then secondary
async function listAllAccounts(req, res) {
  const result = await pool.query(
    `SELECT c.id AS customer_id, c.company_name, c.active AS company_active,
            mu.id AS user_id, mu.name, mu.email, mu.is_main, mu.active AS user_active, mu.created_at
     FROM customers c
     LEFT JOIN mobile_users mu ON mu.customer_id = c.id
     ORDER BY c.company_name, mu.is_main DESC NULLS LAST, mu.created_at ASC`
  );
  res.json(result.rows);
}

// Delete a single mobile_user account. Blocks if deleting the primary and sub-users still exist.
async function deleteAccount(req, res) {
  const { id } = req.params;
  const user = await pool.query('SELECT id, name, email, is_main, customer_id FROM mobile_users WHERE id = $1', [id]);
  if (!user.rows.length) return res.status(404).json({ error: 'Account not found' });

  const { is_main, customer_id, name, email } = user.rows[0];
  if (is_main) {
    const others = await pool.query(
      'SELECT id FROM mobile_users WHERE customer_id = $1 AND id != $2',
      [customer_id, id]
    );
    if (others.rows.length) {
      return res.status(409).json({ error: 'Cannot delete the primary account while team members exist. Remove them first.' });
    }
  }

  await pool.query('DELETE FROM mobile_users WHERE id = $1', [id]);
  res.json({ message: `${name || email} deleted` });
}

module.exports = { listPending, approveCustomer, rejectCustomer, listPendingSubUsers, approveSubUser, rejectSubUser, listAllAccounts, deleteAccount };

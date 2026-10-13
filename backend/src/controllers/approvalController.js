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
    // Normally the signup that created the company is already is_main, but if
    // that account is gone the oldest linked account takes over.
    await promoteIfNoMain(client, id);
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

// Approving scans the company's linked accounts: if none of them is the primary
// contact (e.g. a QB-synced company whose first mobile user is this one), the
// approved account is promoted so the company has someone who can manage its team.
async function approveSubUser(req, res) {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pending = await client.query(
      'SELECT customer_id FROM mobile_users WHERE id = $1 AND is_main = FALSE AND active = FALSE',
      [id]
    );
    if (!pending.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending sub-user not found' });
    }
    const { customer_id } = pending.rows[0];
    // Serialize approvals per company so two concurrent ones can't both be promoted
    await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customer_id]);

    const result = await client.query(
      `UPDATE mobile_users SET active = TRUE
       WHERE id = $1 AND is_main = FALSE AND active = FALSE
       RETURNING id, name, email`,
      [id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pending sub-user not found' });
    }
    const promoted = (await promoteIfNoMain(client, customer_id, id)) !== null;
    await client.query('COMMIT');

    const who = result.rows[0].name || result.rows[0].email;
    res.json({
      message: promoted
        ? `${who} approved and made the primary account (company had none)`
        : `${who} approved`,
      promoted_to_main: promoted,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// If no account under the company holds is_main, promotes preferId (or, when
// omitted, the oldest active account). Returns the promoted user id, or null
// if the company already had a primary / has no active accounts.
async function promoteIfNoMain(client, customerId, preferId = null) {
  const main = await client.query(
    'SELECT id FROM mobile_users WHERE customer_id = $1 AND is_main = TRUE LIMIT 1',
    [customerId]
  );
  if (main.rows.length) return null;

  const promoted = await client.query(
    `UPDATE mobile_users SET is_main = TRUE
     WHERE id = COALESCE($2::int, (
       SELECT id FROM mobile_users
       WHERE customer_id = $1 AND active = TRUE
       ORDER BY created_at ASC, id ASC LIMIT 1
     ))
     RETURNING id`,
    [customerId, preferId]
  );
  return promoted.rows[0]?.id ?? null;
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

// Makes an active mobile_user the primary contact for their company, demoting
// whoever currently holds is_main (if anyone) under the same customer_id.
async function setMainUser(req, res) {
  const { id } = req.params;
  const user = await pool.query('SELECT id, name, email, is_main, active, customer_id FROM mobile_users WHERE id = $1', [id]);
  if (!user.rows.length) return res.status(404).json({ error: 'Account not found' });

  const { name, email, is_main, active, customer_id } = user.rows[0];
  if (!active) return res.status(409).json({ error: 'Cannot make a pending account the primary contact' });
  if (is_main) return res.json({ message: `${name || email} is already the primary account` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE mobile_users SET is_main = FALSE WHERE customer_id = $1 AND is_main = TRUE', [customer_id]);
    await client.query('UPDATE mobile_users SET is_main = TRUE WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ message: `${name || email} is now the primary account` });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Moves a mobile_user to a different company: an existing active one
// ({ customer_id }) or one created here ({ new_company: { company_name, phone,
// address } }). Only the login's link changes — orders already placed stay
// with the company they were placed for (they are that company's invoices in
// QuickBooks), and nothing is sent to QuickBooks: a company created here gets
// its QuickBooks customer the usual way, on its first order.
//
// The account keeps its approved/pending state but not its primary role; it
// becomes primary again only if it is approved and the new company has none.
// If it was the old company's primary, the oldest approved account left there
// takes over. A never-approved signup company left with no accounts, orders,
// or QuickBooks link is removed, since it only existed for this account.
async function changeUserCompany(req, res) {
  const { id } = req.params;
  const { customer_id, new_company } = req.body || {};
  const newName = (new_company?.company_name || '').trim();
  if (!customer_id === !newName) {
    return res.status(400).json({ error: 'Provide either customer_id (existing company) or new_company.company_name' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fail = async (status, error) => {
      await client.query('ROLLBACK');
      return res.status(status).json({ error });
    };

    const userResult = await client.query(
      'SELECT id, name, email, is_main, active, customer_id FROM mobile_users WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!userResult.rows.length) return fail(404, 'Account not found');
    const user = userResult.rows[0];
    const who = user.name || user.email;

    let target;
    if (customer_id) {
      if (Number(customer_id) === user.customer_id) return fail(409, `${who} is already linked to that company`);
      // Serialize against approvals/promotions on both companies (id order avoids deadlocks)
      await client.query('SELECT id FROM customers WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [[user.customer_id, customer_id]]);
      const found = await client.query('SELECT id, company_name FROM customers WHERE id = $1 AND active = TRUE', [customer_id]);
      if (!found.rows.length) return fail(404, 'Company not found or not active');
      target = found.rows[0];
    } else {
      const dup = await client.query(
        'SELECT id, active FROM customers WHERE LOWER(TRIM(company_name)) = LOWER($1) LIMIT 1',
        [newName]
      );
      if (dup.rows.length) {
        return fail(409, dup.rows[0].active
          ? `A company named "${newName}" already exists — choose it from the existing companies instead`
          : `A company named "${newName}" already exists but is inactive or awaiting approval`);
      }
      await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [user.customer_id]);
      const created = await client.query(
        `INSERT INTO customers (company_name, phone, address, active)
         VALUES ($1, $2, $3, TRUE) RETURNING id, company_name`,
        [newName, new_company.phone || null, new_company.address || null]
      );
      target = created.rows[0];
    }

    await client.query('UPDATE mobile_users SET customer_id = $1, is_main = FALSE WHERE id = $2', [target.id, id]);
    const madePrimary = user.active && (await promoteIfNoMain(client, target.id, id)) !== null;
    const successorId = user.is_main ? await promoteIfNoMain(client, user.customer_id) : null;

    const removed = await client.query(
      `DELETE FROM customers c
       WHERE c.id = $1 AND c.active = FALSE AND c.qb_customer_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM mobile_users mu WHERE mu.customer_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
       RETURNING company_name`,
      [user.customer_id]
    );
    await client.query('COMMIT');

    const notes = [];
    if (madePrimary) notes.push('made the primary account there');
    if (!user.active) notes.push('still pending approval');
    if (successorId) notes.push('previous company\'s primary role passed to its oldest account');
    if (removed.rows.length) notes.push(`empty pending signup "${removed.rows[0].company_name}" removed`);
    res.json({
      message: `${who} moved to ${target.company_name}` + (notes.length ? ` (${notes.join('; ')})` : ''),
      customer_id: target.id,
      company_name: target.company_name,
      company_created: !customer_id,
      made_primary: madePrimary,
      previous_company_removed: removed.rows.length > 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { listPending, approveCustomer, rejectCustomer, listPendingSubUsers, approveSubUser, rejectSubUser, listAllAccounts, deleteAccount, setMainUser, changeUserCompany };

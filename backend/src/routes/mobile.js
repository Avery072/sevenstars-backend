const express = require('express');
const router = express.Router();
const { requireCustomerAuth } = require('../middleware/auth');
const pool = require('../config/db');
const { pushToQB, checkAndReserveStock } = require('../controllers/ordersController');

router.use(requireCustomerAuth);

// GET /api/mobile/products — active products; price hidden when show_price = false.
// quantity_on_hand here is available-to-order (QB's synced count minus what's
// already reserved by pending orders), not the raw QB number.
router.get('/products', async (req, res) => {
  const result = await pool.query(
    `SELECT id, sku, description, category, unit, show_price, image_url,
            (quantity_on_hand - reserved) AS quantity_on_hand,
            CASE WHEN show_price THEN price::text ELSE NULL END AS price
     FROM products
     WHERE active = true
     ORDER BY category, description`
  );
  res.json(result.rows);
});

// POST /api/mobile/orders — create order; prices always from DB, never client-sent
router.post('/orders', async (req, res) => {
  const { delivery_date, notes, items } = req.body;
  const customer_id = req.user.customer_id;

  if (!delivery_date || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'delivery_date and items are required' });
  }

  const productIds = items.map(i => i.product_id);
  const prodResult = await pool.query(
    'SELECT id, price, unit, show_price, qb_item_id FROM products WHERE id = ANY($1) AND active = true',
    [productIds]
  );
  const productMap = Object.fromEntries(prodResult.rows.map(r => [r.id, r]));

  for (const item of items) {
    if (!productMap[item.product_id]) {
      return res.status(400).json({ error: `Product ${item.product_id} not found or inactive` });
    }
    if (!item.quantity || item.quantity < 1) {
      return res.status(400).json({ error: `Invalid quantity for product ${item.product_id}` });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await checkAndReserveStock(client, items);

    const newItemsTotal = items.reduce((sum, item) => {
      const p = productMap[item.product_id];
      return sum + parseFloat(item.quantity) * parseFloat(p.price || 0);
    }, 0);

    // Merge into existing order for same customer+delivery_date rather than creating a new row
    const existingOrder = await client.query(
      'SELECT id FROM orders WHERE customer_id = $1 AND delivery_date = $2 LIMIT 1',
      [customer_id, delivery_date]
    );

    let orderId;
    if (existingOrder.rows.length) {
      orderId = existingOrder.rows[0].id;
      await client.query('UPDATE orders SET total = total + $1 WHERE id = $2', [newItemsTotal, orderId]);
    } else {
      const orderResult = await client.query(
        `INSERT INTO orders (customer_id, delivery_date, notes, total, original_total)
         VALUES ($1, $2, $3, $4, $4) RETURNING id`,
        [customer_id, delivery_date, notes || null, newItemsTotal]
      );
      orderId = orderResult.rows[0].id;
    }

    for (const item of items) {
      const p = productMap[item.product_id];
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit, unit_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, item.product_id, item.quantity, p.unit, p.price, item.notes || null]
      );
    }

    await client.query('COMMIT');

    pushToQB({ id: orderId, customer_id, delivery_date, notes: notes || null }, items).catch(err => {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`QB invoice push failed for mobile order ${orderId}:`, detail);
    });

    res.status(201).json({ message: 'Order placed successfully', order_id: orderId });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  } finally {
    client.release();
  }
});

// PATCH /api/mobile/salmon-prefs — one-time set at signup; rejected if already saved
router.patch('/salmon-prefs', async (req, res) => {
  const { salmon_cut, skin_off, scale, pbo, hg } = req.body;
  const { customer_id } = req.user;

  const existing = await pool.query(
    'SELECT salmon_cut FROM customers WHERE id = $1',
    [customer_id]
  );
  if (!existing.rows.length) return res.status(404).json({ error: 'Customer not found' });
  if (existing.rows[0].salmon_cut !== null) {
    return res.status(409).json({ error: 'Salmon preferences already set. Contact admin to make changes.' });
  }

  const result = await pool.query(
    `UPDATE customers SET salmon_cut = $1, skin_off = $2, scale = $3, pbo = $4, hg = $5
     WHERE id = $6 RETURNING salmon_cut, skin_off, scale, pbo, hg`,
    [salmon_cut || null, skin_off ?? false, scale ?? false, pbo ?? false, hg ?? false, customer_id]
  );

  // Submitting cut prefs completes the quiz for this user.
  await pool.query('UPDATE mobile_users SET quiz_completed = TRUE WHERE id = $1', [req.user.user_id]);

  res.json(result.rows[0]);
});

// GET /api/mobile/quiz-status — should the app show the salmon-cut quiz?
// Completed if this user finished it OR the company already has a preference set.
router.get('/quiz-status', async (req, res) => {
  const result = await pool.query(
    `SELECT (mu.quiz_completed OR c.salmon_cut IS NOT NULL) AS quiz_completed
     FROM mobile_users mu
     JOIN customers c ON c.id = mu.customer_id
     WHERE mu.id = $1`,
    [req.user.user_id]
  );
  res.json({ quiz_completed: result.rows[0]?.quiz_completed ?? false });
});

// POST /api/mobile/quiz-complete — mark the quiz done without changing company prefs
// (e.g. a main user of an already-configured company acknowledging/skipping the quiz).
router.post('/quiz-complete', async (req, res) => {
  await pool.query('UPDATE mobile_users SET quiz_completed = TRUE WHERE id = $1', [req.user.user_id]);
  res.json({ quiz_completed: true });
});

// ── Sub-user management (main user only) ──────────────────────────────────────

function requireMainUser(req, res, next) {
  if (!req.user.is_main) return res.status(403).json({ error: 'Only the main account user can manage team members' });
  next();
}

// GET /api/mobile/pending-users — pending sub-accounts awaiting main user approval
router.get('/pending-users', requireMainUser, async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, email, created_at
     FROM mobile_users
     WHERE customer_id = $1 AND active = FALSE AND is_main = FALSE
     ORDER BY created_at ASC`,
    [req.user.customer_id]
  );
  res.json(result.rows);
});

// POST /api/mobile/approve-user/:id
router.post('/approve-user/:id', requireMainUser, async (req, res) => {
  const result = await pool.query(
    `UPDATE mobile_users SET active = TRUE
     WHERE id = $1 AND customer_id = $2 AND is_main = FALSE
     RETURNING id, name, email`,
    [req.params.id, req.user.customer_id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'User not found or already approved' });
  res.json({ message: `${result.rows[0].name || result.rows[0].email} approved` });
});

// POST /api/mobile/reject-user/:id
router.post('/reject-user/:id', requireMainUser, async (req, res) => {
  const result = await pool.query(
    `DELETE FROM mobile_users
     WHERE id = $1 AND customer_id = $2 AND is_main = FALSE AND active = FALSE
     RETURNING name, email`,
    [req.params.id, req.user.customer_id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ message: `${result.rows[0].name || result.rows[0].email} rejected` });
});

module.exports = router;

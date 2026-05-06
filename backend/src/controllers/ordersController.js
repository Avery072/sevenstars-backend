const pool = require('../config/db');

async function listOrders(req, res) {
  const { date } = req.query;

  let whereClause, params;
  if (date) {
    whereClause = 'WHERE o.delivery_date = $1';
    params = [date];
  } else {
    whereClause = `WHERE o.delivery_date BETWEEN CURRENT_DATE - INTERVAL '2 days' AND CURRENT_DATE`;
    params = [];
  }

  const result = await pool.query(
    `SELECT o.*, c.company_name, c.first_name, c.last_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     ${whereClause}
     ORDER BY o.delivery_date DESC, o.order_placed_at DESC`,
    params
  );

  res.json(result.rows);
}

async function getOrder(req, res) {
  const { id } = req.params;

  const orderResult = await pool.query(
    `SELECT o.*, c.company_name, c.first_name, c.last_name, c.salmon_cut,
            c.skin_off, c.scale, c.pbo_hg
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1`,
    [id]
  );

  if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });

  const itemsResult = await pool.query(
    `SELECT oi.*, p.sku, p.description
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1`,
    [id]
  );

  res.json({ ...orderResult.rows[0], items: itemsResult.rows });
}

async function createOrder(req, res) {
  const { customer_id, delivery_date, notes, items } = req.body;

  if (!customer_id || !delivery_date || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'customer_id, delivery_date, and items are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const total = items.reduce((sum, item) => sum + (item.quantity * (item.unit_price || 0)), 0);

    const orderResult = await client.query(
      `INSERT INTO orders (customer_id, delivery_date, notes, total)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [customer_id, delivery_date, notes, total]
    );
    const order = orderResult.rows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit, unit_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, item.product_id, item.quantity, item.unit, item.unit_price, item.notes]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(order);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Deletes orders (and their line items via CASCADE) older than 3 days.
async function purgeOldOrders() {
  const result = await pool.query(
    `DELETE FROM orders WHERE delivery_date < CURRENT_DATE - INTERVAL '2 days'`
  );
  if (result.rowCount > 0) {
    console.log(`Purged ${result.rowCount} order(s) older than 3 days`);
  }
}

module.exports = { listOrders, getOrder, createOrder, purgeOldOrders };

const pool = require('../config/db');
const { createQBInvoice } = require('../middleware/qbSync');

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

    // Push to QuickBooks async — don't block the response
    pushToQB(order, items).catch(err => console.error('QB invoice push failed:', err.message));

    res.status(201).json(order);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function pushToQB(order, items) {
  // Fetch customer qb_customer_id
  const custResult = await pool.query('SELECT qb_customer_id FROM customers WHERE id = $1', [order.customer_id]);
  const qbCustomerId = custResult.rows[0]?.qb_customer_id;
  if (!qbCustomerId) throw new Error(`Customer ${order.customer_id} has no QB ID — skipping invoice`);

  // Fetch qb_item_id for each product
  const productIds = items.map(i => i.product_id);
  const prodResult = await pool.query('SELECT id, qb_item_id FROM products WHERE id = ANY($1)', [productIds]);
  const qbItemMap = Object.fromEntries(prodResult.rows.map(r => [r.id, r.qb_item_id]));

  const lines = items
    .filter(item => qbItemMap[item.product_id])
    .map(item => ({
      Amount: parseFloat(item.quantity) * parseFloat(item.unit_price || 0),
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: qbItemMap[item.product_id] },
        Qty: parseFloat(item.quantity),
        UnitPrice: parseFloat(item.unit_price || 0),
      },
    }));

  if (!lines.length) throw new Error('No QB-linked items on order — skipping invoice');

  const payload = {
    CustomerRef: { value: qbCustomerId },
    TxnDate: order.delivery_date,
    Line: lines,
    ...(order.notes ? { CustomerMemo: { value: order.notes } } : {}),
  };

  const invoice = await createQBInvoice(payload);
  await pool.query('UPDATE orders SET qb_invoice_id = $1 WHERE id = $2', [invoice.Id, order.id]);
  console.log(`QB invoice ${invoice.Id} created for order ${order.id}`);
}

// Finds all orders without a qb_invoice_id and retries the QB push.
async function syncPendingInvoices(req, res) {
  const { rows: orders } = await pool.query(
    `SELECT o.*, oi.product_id, oi.quantity, oi.unit, oi.unit_price, oi.notes AS item_notes
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.qb_invoice_id IS NULL
     ORDER BY o.id`
  );

  if (!orders.length) return res.json({ message: 'No pending invoices', synced: 0, failed: 0 });

  // Group line items back onto their orders
  const orderMap = {};
  for (const row of orders) {
    if (!orderMap[row.id]) {
      orderMap[row.id] = {
        id: row.id, customer_id: row.customer_id,
        delivery_date: row.delivery_date, notes: row.notes, total: row.total,
        items: []
      };
    }
    orderMap[row.id].items.push({
      product_id: row.product_id, quantity: row.quantity,
      unit: row.unit, unit_price: row.unit_price, notes: row.item_notes
    });
  }

  let synced = 0, failed = 0;
  for (const order of Object.values(orderMap)) {
    try {
      await pushToQB(order, order.items);
      synced++;
    } catch (err) {
      console.error(`Pending invoice sync failed for order ${order.id}:`, err.message);
      failed++;
    }
  }

  res.json({ message: 'Sync complete', synced, failed });
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

module.exports = { listOrders, getOrder, createOrder, syncPendingInvoices, purgeOldOrders };

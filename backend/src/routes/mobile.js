const express = require('express');
const router = express.Router();
const { requireCustomerAuth } = require('../middleware/auth');
const pool = require('../config/db');
const { createQBInvoice, appendToQBInvoice, createQBCustomer, getQBClient } = require('../middleware/qbSync');

router.use(requireCustomerAuth);

// GET /api/mobile/products — active products; price hidden when show_price = false
router.get('/products', async (req, res) => {
  const result = await pool.query(
    `SELECT id, sku, description, category, unit, show_price, image_url, quantity_on_hand,
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

    const total = items.reduce((sum, item) => {
      const p = productMap[item.product_id];
      return sum + parseFloat(item.quantity) * parseFloat(p.price || 0);
    }, 0);

    const orderResult = await client.query(
      `INSERT INTO orders (customer_id, delivery_date, notes, total)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [customer_id, delivery_date, notes || null, total]
    );
    const order = orderResult.rows[0];

    for (const item of items) {
      const p = productMap[item.product_id];
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit, unit_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, item.product_id, item.quantity, p.unit, p.price, item.notes || null]
      );
    }

    await client.query('COMMIT');

    pushToQB(order, items, productMap).catch(err =>
      console.error('QB invoice push failed for mobile order:', err.message)
    );

    res.status(201).json({ message: 'Order placed successfully', order_id: order.id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

async function pushToQB(order, items, productMap) {
  const custResult = await pool.query(
    `SELECT c.qb_customer_id, c.company_name, c.first_name, c.last_name, c.phone,
            COALESCE(c.email, mu.email) AS email
     FROM customers c
     LEFT JOIN mobile_users mu ON mu.customer_id = c.id
     WHERE c.id = $1
     LIMIT 1`,
    [order.customer_id]
  );
  const customer = custResult.rows[0];
  let qbCustomerId = customer?.qb_customer_id;

  if (!qbCustomerId) {
    const displayName = customer.company_name ||
      [customer.first_name, customer.last_name].filter(Boolean).join(' ') ||
      `Customer ${order.customer_id}`;

    try {
      const qbClient = await getQBClient();
      const q = `SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g, "\\'")}'`;
      const { data } = await qbClient.get(`/query?query=${encodeURIComponent(q)}&minorversion=65`);
      const existing = data?.QueryResponse?.Customer?.[0];
      if (existing) {
        qbCustomerId = existing.Id;
        console.log(`Found existing QB customer ${qbCustomerId} for "${displayName}"`);
      }
    } catch (e) {
      console.warn('QB customer lookup failed, will attempt create:', e.message);
    }

    if (!qbCustomerId) {
      const qbCustomer = await createQBCustomer({
        DisplayName: displayName,
        CompanyName: customer.company_name || null,
        GivenName: customer.first_name || null,
        FamilyName: customer.last_name || null,
        PrimaryEmailAddr: customer.email ? { Address: customer.email } : undefined,
        PrimaryPhone: customer.phone ? { FreeFormNumber: customer.phone } : undefined,
      });
      qbCustomerId = qbCustomer.Id;
      console.log(`Created QB customer ${qbCustomerId} for local customer ${order.customer_id}`);
    }

    await pool.query(
      'UPDATE customers SET qb_customer_id = $1 WHERE id = $2',
      [qbCustomerId, order.customer_id]
    );
  }

  const lines = items
    .filter(item => productMap[item.product_id]?.qb_item_id)
    .map(item => {
      const p = productMap[item.product_id];
      return {
        Amount: parseFloat(item.quantity) * parseFloat(p.price || 0),
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: p.qb_item_id },
          Qty: parseFloat(item.quantity),
          UnitPrice: parseFloat(p.price || 0),
        },
      };
    });

  if (!lines.length) throw new Error('No QB-linked items — skipping invoice');

  // Merge into existing invoice if one already exists for this customer + delivery date
  const existing = await pool.query(
    `SELECT qb_invoice_id FROM orders
     WHERE customer_id = $1 AND delivery_date = $2 AND qb_invoice_id IS NOT NULL
     ORDER BY id ASC LIMIT 1`,
    [order.customer_id, order.delivery_date]
  );

  let invoiceId;
  if (existing.rows.length) {
    try {
      const updated = await appendToQBInvoice(existing.rows[0].qb_invoice_id, lines);
      invoiceId = updated.Id;
      console.log(`QB invoice ${invoiceId} updated — merged mobile order ${order.id} into existing invoice`);
    } catch (appendErr) {
      console.warn(`QB invoice ${existing.rows[0].qb_invoice_id} unreachable (deleted/voided in QB), creating new invoice. Error: ${appendErr.message}`);
      await pool.query('UPDATE orders SET qb_invoice_id = NULL WHERE qb_invoice_id = $1', [existing.rows[0].qb_invoice_id]);
      const payload = {
        CustomerRef: { value: qbCustomerId },
        TxnDate: order.delivery_date,
        Line: lines,
        ...(order.notes ? { CustomerMemo: { value: order.notes } } : {}),
      };
      const invoice = await createQBInvoice(payload);
      invoiceId = invoice.Id;
      console.log(`QB invoice ${invoiceId} created (fallback) for mobile order ${order.id}`);
    }
  } else {
    const payload = {
      CustomerRef: { value: qbCustomerId },
      TxnDate: order.delivery_date,
      Line: lines,
      ...(order.notes ? { CustomerMemo: { value: order.notes } } : {}),
    };
    const invoice = await createQBInvoice(payload);
    invoiceId = invoice.Id;
    console.log(`QB invoice ${invoiceId} created for mobile order ${order.id}`);
  }

  await pool.query('UPDATE orders SET qb_invoice_id = $1 WHERE id = $2', [invoiceId, order.id]);
}

// PATCH /api/mobile/profile — update company-level salmon cut preferences
// Writes to the customers table so every user under the same company is updated
router.patch('/profile', async (req, res) => {
  const customer_id = req.user.customer_id;
  const { salmon_cut, skin_off, scale, pbo, hg } = req.body;

  const allowed = { salmon_cut, skin_off, scale, pbo, hg };
  const sets = [];
  const values = [];
  let idx = 1;

  for (const [key, val] of Object.entries(allowed)) {
    if (val !== undefined) {
      sets.push(`${key} = $${idx++}`);
      values.push(val);
    }
  }

  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

  values.push(customer_id);
  const result = await pool.query(
    `UPDATE customers SET ${sets.join(', ')} WHERE id = $${idx} RETURNING
       id, salmon_cut, skin_off, scale, pbo, hg`,
    values
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Customer not found' });
  res.json(result.rows[0]);
});

module.exports = router;

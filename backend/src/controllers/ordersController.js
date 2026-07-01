const pool = require('../config/db');
const { createQBInvoice, appendToQBInvoice, createQBCustomer, getQBClient } = require('../middleware/qbSync');

async function listOrders(req, res) {
  const { date, customer_id } = req.query;

  const conditions = [];
  const params = [];

  if (date) {
    params.push(date);
    conditions.push(`o.delivery_date = $${params.length}`);
  } else {
    conditions.push(`o.delivery_date BETWEEN CURRENT_DATE - INTERVAL '2 days' AND CURRENT_DATE`);
  }

  if (customer_id) {
    params.push(customer_id);
    conditions.push(`o.customer_id = $${params.length}`);
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ');

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
            c.skin_off, c.scale, c.pbo, c.hg
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
    pushToQB(order, items).catch(err => {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`QB invoice push failed for order ${order.id}:`, detail);
    });

    res.status(201).json(order);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function pushToQB(order, items) {
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

    // Search QB first — avoid duplicate name error if customer already exists there
    try {
      const qbClient = await getQBClient();
      const q = `SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g, "''")}'`;
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

    // Only update if this qb_customer_id isn't already assigned to another row
    const taken = await pool.query('SELECT id FROM customers WHERE qb_customer_id = $1', [qbCustomerId]);
    if (!taken.rows.length) {
      await pool.query('UPDATE customers SET qb_customer_id = $1 WHERE id = $2', [qbCustomerId, order.customer_id]);
    }
  }

  // Fetch qb_item_id and canonical price from DB for each product
  const productIds = items.map(i => i.product_id);
  const prodResult = await pool.query('SELECT id, qb_item_id, price FROM products WHERE id = ANY($1)', [productIds]);
  const productMap = Object.fromEntries(prodResult.rows.map(r => [r.id, r]));

  const noQbId = items.filter(i => !productMap[i.product_id]?.qb_item_id).map(i => i.product_id);
  if (noQbId.length) {
    console.warn(`Order ${order.id}: skipping ${noQbId.length} item(s) with no qb_item_id — product ids: ${noQbId.join(', ')}`);
  }

  const lines = items
    .filter(item => productMap[item.product_id]?.qb_item_id)
    .map(item => {
      const p = productMap[item.product_id];
      const unitPrice = parseFloat(p.price ?? item.unit_price ?? 0);
      return {
        Amount: parseFloat(item.quantity) * unitPrice,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: p.qb_item_id },
          Qty: parseFloat(item.quantity),
          UnitPrice: unitPrice,
        },
      };
    });

  if (!lines.length) throw new Error(`No QB-linked items on order ${order.id} — run Sync from QB to populate qb_item_id on products`);

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
      console.log(`QB invoice ${invoiceId} updated — merged order ${order.id} into existing invoice`);
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
      console.log(`QB invoice ${invoiceId} created (fallback) for order ${order.id}`);
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
    console.log(`QB invoice ${invoiceId} created for order ${order.id}`);
  }

  await pool.query('UPDATE orders SET qb_invoice_id = $1 WHERE id = $2', [invoiceId, order.id]);
}

async function deleteOrder(req, res) {
  const { id } = req.params;
  const result = await pool.query('DELETE FROM orders WHERE id = $1 RETURNING id', [id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
  res.json({ message: 'Order deleted' });
}

async function getPackingReport(req, res) {
  const date = req.query.date || null;
  const result = await pool.query(
    `SELECT
       p.id AS product_id,
       p.sku,
       p.description,
       oi.unit,
       c.id AS customer_id,
       c.company_name,
       SUM(oi.quantity)::float AS quantity,
       COALESCE(string_agg(DISTINCT NULLIF(oi.notes, ''), '; '), '') AS notes
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN products p ON p.id = oi.product_id
     JOIN customers c ON c.id = o.customer_id
     WHERE o.delivery_date = COALESCE($1::date, CURRENT_DATE)
     GROUP BY p.id, p.sku, p.description, oi.unit, c.id, c.company_name
     ORDER BY p.description ASC, c.company_name ASC`,
    [date]
  );

  const products = [];
  const productMap = new Map();

  for (const row of result.rows) {
    const key = `${row.product_id}:${row.unit}`;
    if (!productMap.has(key)) {
      const product = {
        product_id: row.product_id,
        sku: row.sku,
        description: row.description,
        unit: row.unit,
        total_qty: 0,
        customers: [],
      };
      productMap.set(key, product);
      products.push(product);
    }

    const product = productMap.get(key);
    product.total_qty += Number(row.quantity || 0);
    product.customers.push({
      company_name: row.company_name,
      quantity: Number(row.quantity || 0),
      unit: row.unit,
      notes: row.notes || '',
    });
  }

  res.json(products);
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
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`Pending invoice sync failed for order ${order.id}:`, detail);
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

module.exports = { listOrders, getOrder, createOrder, deleteOrder, getPackingReport, syncPendingInvoices, purgeOldOrders };

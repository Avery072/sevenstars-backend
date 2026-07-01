const crypto = require('crypto');
const pool = require('../config/db');
const { fetchQBItem, fetchQBCustomer, fetchQBInvoice } = require('../middleware/qbSync');

// QB sends a signature in the intuit-signature header; verify before processing.
function verifySignature(req) {
  const signature = req.headers['intuit-signature'];
  if (!signature) return false;

  const verifierToken = process.env.QB_WEBHOOK_VERIFIER_TOKEN;
  const hash = crypto
    .createHmac('sha256', verifierToken)
    .update(JSON.stringify(req.body))
    .digest('base64');

  return hash === signature;
}

async function handleWebhook(req, res) {
  // Respond immediately — QB requires a fast 200
  if (!verifySignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  res.sendStatus(200);

  // Process async after responding
  processWebhookPayload(req.body).catch((err) =>
    console.error('Webhook processing error:', err.message)
  );
}

async function processWebhookPayload(payload) {
  const events = payload?.eventNotifications || [];

  for (const notification of events) {
    const entities = notification?.dataChangeEvent?.entities || [];
    for (const entity of entities) {
      const { name, id, operation } = entity;

      if (name === 'Item') {
        await syncItem(id, operation);
      } else if (name === 'Invoice') {
        await syncInvoice(id, operation);
      } else if (name === 'Customer') {
        await syncCustomer(id, operation);
      }
    }
  }
}

async function syncItem(qbItemId, operation) {
  if (operation === 'Delete') {
    await pool.query('UPDATE products SET active = FALSE WHERE qb_item_id = $1', [qbItemId]);
    return;
  }

  const item = await fetchQBItem(qbItemId);
  await pool.query(
    `INSERT INTO products (qb_item_id, sku, description, price, cost, active, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (qb_item_id) DO UPDATE
       SET sku = EXCLUDED.sku,
           description = EXCLUDED.description,
           price = EXCLUDED.price,
           cost = EXCLUDED.cost,
           active = EXCLUDED.active,
           updated_at = NOW()`,
    [
      item.Id,
      item.Name,
      item.Description || item.Name,
      item.UnitPrice || 0,
      item.PurchaseCost || 0,
      item.Active !== false,
    ]
  );
}

async function syncInvoice(qbInvoiceId, operation) {
  if (operation === 'Delete') {
    await pool.query('UPDATE orders SET qb_invoice_id = NULL WHERE qb_invoice_id = $1', [qbInvoiceId]);
    console.log(`QB invoice ${qbInvoiceId} deleted — unlinked from orders`);
    return;
  }

  const invoice = await fetchQBInvoice(qbInvoiceId);
  if (!invoice) return;

  // If we already have order(s) with this invoice ID they were created by our mobile app — just update total.
  const existing = await pool.query('SELECT id FROM orders WHERE qb_invoice_id = $1 LIMIT 1', [qbInvoiceId]);
  if (existing.rows.length) {
    await pool.query('UPDATE orders SET total = $1 WHERE qb_invoice_id = $2', [parseFloat(invoice.TotalAmt || 0), qbInvoiceId]);
    return;
  }

  // Invoice was created directly in QB — resolve the customer.
  const qbCustomerId = invoice.CustomerRef?.value;
  if (!qbCustomerId) {
    console.warn(`QB invoice ${qbInvoiceId} has no CustomerRef — skipping`);
    return;
  }

  let customerId;
  const custResult = await pool.query('SELECT id FROM customers WHERE qb_customer_id = $1', [qbCustomerId]);
  if (custResult.rows.length) {
    customerId = custResult.rows[0].id;
  } else {
    // Customer not yet in our DB — sync them in.
    const qbCustomer = await fetchQBCustomer(qbCustomerId);
    const inserted = await pool.query(
      `INSERT INTO customers (qb_customer_id, company_name, first_name, last_name, phone, email, active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (qb_customer_id) DO UPDATE
         SET company_name = EXCLUDED.company_name, first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name, phone = EXCLUDED.phone,
             email = EXCLUDED.email, active = EXCLUDED.active
       RETURNING id`,
      [
        qbCustomer.Id,
        qbCustomer.CompanyName || [qbCustomer.GivenName, qbCustomer.FamilyName].filter(Boolean).join(' '),
        qbCustomer.GivenName || null,
        qbCustomer.FamilyName || null,
        qbCustomer.PrimaryPhone?.FreeFormNumber || null,
        qbCustomer.PrimaryEmailAddr?.Address || null,
      ]
    );
    customerId = inserted.rows[0].id;
  }

  const deliveryDate = invoice.TxnDate; // YYYY-MM-DD
  const notes = invoice.CustomerMemo?.value || null;
  const total = parseFloat(invoice.TotalAmt || 0);
  const salesLines = (invoice.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderResult = await client.query(
      `INSERT INTO orders (qb_invoice_id, customer_id, delivery_date, notes, total)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [qbInvoiceId, customerId, deliveryDate, notes, total]
    );
    const orderId = orderResult.rows[0].id;

    let itemsInserted = 0;
    for (const line of salesLines) {
      const qbItemId = line.SalesItemLineDetail?.ItemRef?.value;
      if (!qbItemId) continue;

      const prodResult = await client.query('SELECT id, unit FROM products WHERE qb_item_id = $1', [qbItemId]);
      if (!prodResult.rows.length) continue; // item not yet synced to our products table

      const product = prodResult.rows[0];
      const qty = parseFloat(line.SalesItemLineDetail?.Qty || 0);
      const unitPrice = parseFloat(line.SalesItemLineDetail?.UnitPrice || 0);
      const lineNotes = line.Description || null;

      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit, unit_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, product.id, qty, product.unit, unitPrice, lineNotes]
      );
      itemsInserted++;
    }

    await client.query('COMMIT');
    console.log(`QB invoice ${qbInvoiceId} → order ${orderId} created (${itemsInserted} line items)`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function syncCustomer(qbCustomerId, operation) {
  if (operation === 'Delete') {
    await pool.query('UPDATE customers SET active = FALSE WHERE qb_customer_id = $1', [qbCustomerId]);
    return;
  }

  const customer = await fetchQBCustomer(qbCustomerId);
  await pool.query(
    `INSERT INTO customers (qb_customer_id, company_name, first_name, last_name, phone, email, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (qb_customer_id) DO UPDATE
       SET company_name = EXCLUDED.company_name,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           active = EXCLUDED.active`,
    [
      customer.Id,
      customer.CompanyName || `${customer.GivenName} ${customer.FamilyName}`.trim(),
      customer.GivenName || null,
      customer.FamilyName || null,
      customer.PrimaryPhone?.FreeFormNumber || null,
      customer.PrimaryEmailAddr?.Address || null,
      customer.Active !== false,
    ]
  );
}

module.exports = { handleWebhook };

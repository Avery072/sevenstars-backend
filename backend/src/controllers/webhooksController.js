const crypto = require('crypto');
const pool = require('../config/db');
const { fetchQBItem, fetchQBCustomer, fetchQBInvoice } = require('../middleware/qbSync');
const { upsertQBItem } = require('../services/qbEntitySync');

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
  if (item.Type === 'Category' || item.Type === 'Group') return;

  const result = await upsertQBItem(item);
  if (result) {
    console.log(`QB webhook — item ${result.status} "${result.sku || result.description}"`, result.changes || '(new)');
  }
}

// processInvoice handles a full QB Invoice object — used by both the webhook and the bulk sync.
// Returns 'created', 'updated', or 'skipped'.
async function processInvoice(invoice) {
  const qbInvoiceId = invoice.Id;

  // If we already have an order with this invoice ID — update total and flag if it changed.
  const existing = await pool.query('SELECT id, total FROM orders WHERE qb_invoice_id = $1 LIMIT 1', [qbInvoiceId]);
  if (existing.rows.length) {
    const qbTotal = parseFloat(invoice.TotalAmt || 0);
    const dbTotal = parseFloat(existing.rows[0].total || 0);
    if (Math.abs(qbTotal - dbTotal) > 0.005) {
      await pool.query(
        'UPDATE orders SET total = $1, status = $2 WHERE qb_invoice_id = $3',
        [qbTotal, 'modified', qbInvoiceId]
      );
    }
    return 'updated';
  }

  // Invoice was created directly in QB — resolve the customer.
  const qbCustomerId = invoice.CustomerRef?.value;
  if (!qbCustomerId) {
    console.warn(`QB invoice ${qbInvoiceId} has no CustomerRef — skipping`);
    return 'skipped';
  }

  let customerId;
  const custResult = await pool.query('SELECT id FROM customers WHERE qb_customer_id = $1', [qbCustomerId]);
  if (custResult.rows.length) {
    customerId = custResult.rows[0].id;
  } else {
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

  const deliveryDate = invoice.TxnDate;
  const notes = invoice.CustomerMemo?.value || null;
  const total = parseFloat(invoice.TotalAmt || 0);
  const salesLines = (invoice.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderResult = await client.query(
      `INSERT INTO orders (qb_invoice_id, qb_doc_number, customer_id, delivery_date, notes, total)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [qbInvoiceId, invoice.DocNumber || null, customerId, deliveryDate, notes, total]
    );
    const orderId = orderResult.rows[0].id;

    let itemsInserted = 0;
    for (const line of salesLines) {
      const qbItemId = line.SalesItemLineDetail?.ItemRef?.value;
      if (!qbItemId) continue;

      const prodResult = await client.query('SELECT id, unit FROM products WHERE qb_item_id = $1', [qbItemId]);
      if (!prodResult.rows.length) continue;

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
    return 'created';
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function syncInvoice(qbInvoiceId, operation) {
  if (operation === 'Delete') {
    await pool.query('UPDATE orders SET status = $1 WHERE qb_invoice_id = $2', ['voided', qbInvoiceId]);
    console.log(`QB invoice ${qbInvoiceId} voided in QB — order marked voided`);
    return;
  }
  const invoice = await fetchQBInvoice(qbInvoiceId);
  if (!invoice) return;
  await processInvoice(invoice);
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

module.exports = { handleWebhook, syncInvoice, processInvoice };

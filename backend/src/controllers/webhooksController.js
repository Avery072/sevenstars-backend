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

// QBO's documented convention: voiding an invoice (rather than hard-deleting it)
// prepends "Voided" to PrivateNote and zeroes its amounts — it does NOT reliably
// arrive as a webhook Delete operation, since the record stays in place. This is
// the signal that actually catches the common real-world "staff clicked Void in
// the QBO UI" case.
function isVoided(invoice) {
  return (invoice.PrivateNote || '').includes('Voided');
}

// Reconciles an existing local order's line items against a freshly-fetched QB
// invoice. QB is ground truth for line composition/qty/price: lines it no longer
// has are soft-removed (status='removed', kept for audit trail), lines it has
// that we don't are inserted, and matched lines (by qb_line_id) get their
// product/qty/price updated in place. Matching is keyed on qb_line_id rather
// than product_id because a product can appear as two separate lines, or a
// line's item can be swapped entirely.
async function reconcileExistingOrder(order, invoice) {
  const qbLines = (invoice.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail');
  const qbByLineId = new Map(qbLines.filter(l => l.Id != null).map(l => [l.Id, l]));

  const client = await pool.connect();
  let linesAdded = 0, linesRemoved = 0, linesChanged = 0;
  try {
    await client.query('BEGIN');

    const localItems = await client.query(
      `SELECT id, qb_line_id, product_id, quantity, unit_price
       FROM order_items WHERE order_id = $1 AND status = 'active'`,
      [order.id]
    );

    for (const item of localItems.rows) {
      if (!item.qb_line_id) continue; // legacy row never backfilled with a QB line id — leave alone

      const line = qbByLineId.get(item.qb_line_id);
      if (!line) {
        await client.query(`UPDATE order_items SET status = 'removed' WHERE id = $1`, [item.id]);
        linesRemoved++;
        continue;
      }
      qbByLineId.delete(item.qb_line_id); // mark matched

      const qbItemId = line.SalesItemLineDetail?.ItemRef?.value;
      const prodResult = await client.query('SELECT id, unit FROM products WHERE qb_item_id = $1', [qbItemId]);
      if (!prodResult.rows.length) continue; // unknown item — same skip as the create path

      const product = prodResult.rows[0];
      const newQty = parseFloat(line.SalesItemLineDetail?.Qty || 0);
      const newPrice = parseFloat(line.SalesItemLineDetail?.UnitPrice || 0);
      const changed = product.id !== item.product_id
        || Math.abs(newQty - parseFloat(item.quantity)) > 0.0001
        || Math.abs(newPrice - parseFloat(item.unit_price)) > 0.0001;

      if (changed) {
        await client.query(
          `UPDATE order_items SET product_id = $1, unit = $2, quantity = $3, unit_price = $4 WHERE id = $5`,
          [product.id, product.unit, newQty, newPrice, item.id]
        );
        linesChanged++;
      }
    }

    // Whatever's left in qbByLineId are lines QB has that we don't — added directly in QB.
    for (const line of qbByLineId.values()) {
      const qbItemId = line.SalesItemLineDetail?.ItemRef?.value;
      if (!qbItemId) continue;
      const prodResult = await client.query('SELECT id, unit FROM products WHERE qb_item_id = $1', [qbItemId]);
      if (!prodResult.rows.length) {
        console.warn(`QB invoice ${invoice.Id}: new line references unknown item ${qbItemId} — skipping`);
        continue;
      }
      const product = prodResult.rows[0];
      const qty = parseFloat(line.SalesItemLineDetail?.Qty || 0);
      const unitPrice = parseFloat(line.SalesItemLineDetail?.UnitPrice || 0);
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit, unit_price, notes, qb_line_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
        [order.id, product.id, qty, product.unit, unitPrice, line.Description || null, line.Id || null]
      );
      linesAdded++;
    }

    const qbTotal = parseFloat(invoice.TotalAmt || 0);
    const totalChanged = Math.abs(qbTotal - parseFloat(order.total || 0)) > 0.005;
    const anyChange = linesAdded > 0 || linesRemoved > 0 || linesChanged > 0 || totalChanged;
    const nextStatus = anyChange ? 'modified' : order.status;
    await client.query('UPDATE orders SET total = $1, status = $2 WHERE id = $3', [qbTotal, nextStatus, order.id]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (linesAdded || linesRemoved || linesChanged) {
    console.log(`QB invoice ${invoice.Id} → order ${order.id} reconciled (+${linesAdded} -${linesRemoved} ~${linesChanged})`);
  }

  return { status: 'updated', linesAdded, linesRemoved, linesChanged };
}

// processInvoice handles a full QB Invoice object — used by the webhook, the bulk
// invoice sync, and the discrepancy-check endpoint. Returns { status: 'created' |
// 'updated' | 'voided' | 'skipped', linesAdded?, linesRemoved?, linesChanged? }.
async function processInvoice(invoice) {
  const qbInvoiceId = invoice.Id;

  if (isVoided(invoice)) {
    const result = await pool.query(
      "UPDATE orders SET status = 'voided' WHERE qb_invoice_id = $1 RETURNING id",
      [qbInvoiceId]
    );
    if (!result.rows.length) return { status: 'skipped' }; // nothing local to void
    console.log(`QB invoice ${qbInvoiceId} voided in QB — order ${result.rows[0].id} marked voided`);
    return { status: 'voided' };
  }

  // If we already have an order with this invoice ID — reconcile line items and total.
  const existing = await pool.query('SELECT id, total, status FROM orders WHERE qb_invoice_id = $1 LIMIT 1', [qbInvoiceId]);
  if (existing.rows.length) {
    return reconcileExistingOrder(existing.rows[0], invoice);
  }

  // Invoice was created directly in QB — resolve the customer.
  const qbCustomerId = invoice.CustomerRef?.value;
  if (!qbCustomerId) {
    console.warn(`QB invoice ${qbInvoiceId} has no CustomerRef — skipping`);
    return { status: 'skipped' };
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
        `INSERT INTO order_items (order_id, product_id, quantity, unit, unit_price, notes, qb_line_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
        [orderId, product.id, qty, product.unit, unitPrice, lineNotes, line.Id || null]
      );
      itemsInserted++;
    }

    await client.query('COMMIT');
    console.log(`QB invoice ${qbInvoiceId} → order ${orderId} created (${itemsInserted} line items)`);
    return { status: 'created' };
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

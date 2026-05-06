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
  const invoice = await fetchQBInvoice(qbInvoiceId);
  // Map QB invoice status to our status
  const statusMap = { 'EmailSent': 'processing', 'Paid': 'complete' };
  const status = statusMap[invoice.EmailStatus] || 'pending';

  await pool.query(
    `UPDATE orders SET status = $1 WHERE qb_invoice_id = $2`,
    [status, qbInvoiceId]
  );
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

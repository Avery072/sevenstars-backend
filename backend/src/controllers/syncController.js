const pool = require('../config/db');
const { isValidISODate } = require('../utils/dateValidation');
const { queryQBAll } = require('../middleware/qbSync');
const { processInvoice } = require('./webhooksController');
const { getQBClient } = require('../middleware/qbSync');
const { upsertQBItem, upsertQBCustomer } = require('../services/qbEntitySync');
const { pushToQB, retryOrderEditPush } = require('./ordersController');
const { docNumberCounterStatus, raiseDocNumberCounter } = require('../services/docNumberCounter');

async function syncFromQB(req, res) {
  let items, customers;
  try {
    [items, customers] = await Promise.all([
      queryQBAll('Item'),
      queryQBAll('Customer'),
    ]);
  } catch (err) {
    if (err.message && err.message.includes('Refresh token')) {
      return res.status(401).json({ error: 'QB token expired. Re-authorize at /api/auth/qb' });
    }
    throw err;
  }

  const [itemResults, customerResults] = await Promise.all([
    upsertItems(items),
    upsertCustomers(customers),
  ]);

  for (const r of [...itemResults.changed, ...customerResults.changed]) {
    console.log(`QB sync — ${r.status} "${r.label}":`, r.changes ? r.changes : '(new)');
  }

  res.json({
    message: 'Sync complete',
    items: {
      created: itemResults.created,
      updated: itemResults.updated,
      unchanged: itemResults.unchanged,
      changes: itemResults.changed,
    },
    customers: {
      created: customerResults.created,
      updated: customerResults.updated,
      unchanged: customerResults.unchanged,
      changes: customerResults.changed,
    },
  });
}

async function upsertItems(items) {
  let created = 0, updated = 0, unchanged = 0;
  const changed = [];

  for (const item of items) {
    if (item.Type === 'Category' || item.Type === 'Group') continue;

    const result = await upsertQBItem(item);
    if (!result) {
      unchanged++;
      continue;
    }

    if (result.status === 'created') created++;
    else updated++;

    changed.push({ status: result.status, label: result.sku || result.description, changes: result.changes });
  }

  return { created, updated, unchanged, changed };
}

// Re-reads every QB item (one paged query) and upserts it — the scheduled
// backstop that keeps quantity_on_hand following QB even when a webhook is
// missed or never sent. Same upsert path as the manual "Sync from QB".
async function refreshItemsFromQB() {
  const items = await queryQBAll('Item');
  return upsertItems(items);
}

async function upsertCustomers(customers) {
  let created = 0, updated = 0, unchanged = 0;
  const changed = [];

  for (const c of customers) {
    const result = await upsertQBCustomer(c);
    if (!result) {
      unchanged++;
      continue;
    }

    if (result.status === 'created') created++;
    else updated++;

    changed.push({ status: result.status, label: result.name, changes: result.changes });
  }

  return { created, updated, unchanged, changed };
}

async function syncInvoicesFromQB(req, res) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const sinceStr = req.query.date || today;
  if (req.query.date && !isValidISODate(sinceStr)) {
    return res.status(400).json({ error: 'date must be a valid YYYY-MM-DD date' });
  }

  let invoices;
  try {
    const client = await getQBClient();
    const pageSize = 1000;
    let startPosition = 1;
    invoices = [];
    while (true) {
      const query = `SELECT * FROM Invoice WHERE TxnDate >= '${sinceStr}' MAXRESULTS ${pageSize} STARTPOSITION ${startPosition}`;
      const { data } = await client.get(`/query?query=${encodeURIComponent(query)}&minorversion=65`);
      const rows = data?.QueryResponse?.Invoice || [];
      invoices.push(...rows);
      if (rows.length < pageSize) break;
      startPosition += pageSize;
    }
  } catch (err) {
    if (err.message?.includes('Refresh token')) {
      return res.status(401).json({ error: 'QB token expired. Re-authorize at /api/auth/qb' });
    }
    throw err;
  }

  let created = 0, updated = 0, unchanged = 0, voided = 0, skipped = 0;
  for (const inv of invoices) {
    try {
      const result = await processInvoice(inv);
      if (result.status === 'created') created++;
      else if (result.status === 'updated') updated++;
      else if (result.status === 'unchanged') unchanged++;
      else if (result.status === 'voided') voided++;
      else skipped++;
    } catch (err) {
      console.error(`Failed to sync QB invoice ${inv.Id}:`, err.message);
      skipped++;
    }
  }

  res.json({ message: 'Invoice sync complete', date: sinceStr, total: invoices.length, created, updated, unchanged, voided, skipped });
}

// Fetches all QB invoices with TxnDate in [from, to], paginated.
async function queryQBInvoicesInRange(from, to) {
  const client = await getQBClient();
  const pageSize = 1000;
  let startPosition = 1;
  const invoices = [];
  while (true) {
    const query = `SELECT * FROM Invoice WHERE TxnDate >= '${from}' AND TxnDate <= '${to}' MAXRESULTS ${pageSize} STARTPOSITION ${startPosition}`;
    const { data } = await client.get(`/query?query=${encodeURIComponent(query)}&minorversion=65`);
    const rows = data?.QueryResponse?.Invoice || [];
    invoices.push(...rows);
    if (rows.length < pageSize) break;
    startPosition += pageSize;
  }
  return invoices;
}

// Bidirectional reconciliation for a date-range window (the admin portal's
// currently-selected order filter): local orders QB doesn't have yet get pushed
// to QB (additive — the app never deletes on QB's behalf), and every QB invoice
// in the window is reconciled against local state via processInvoice, which
// pulls in anything missing locally and applies line-level updates/removals/void
// detection to anything that already exists. QB stays the sole source of
// destructive changes (line removal, voiding); existence gaps are healed
// additively on whichever side is missing the record.
async function reconcileOrders(req, res) {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });
  }
  if (!isValidISODate(from) || !isValidISODate(to)) {
    return res.status(400).json({ error: 'from and to must be valid YYYY-MM-DD dates' });
  }
  const result = await runReconciliation(from, to);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
}

// Core reconciliation logic, shared by the admin "Check QB Discrepancies"
// button and the periodic background job in app.js — QB webhook delivery is
// explicitly best-effort (Intuit doesn't guarantee delivery, ordering, or
// retry-until-success), so this is the actual correctness backstop, not just
// a manual convenience.
async function runReconciliation(from, to) {
  let pushed = 0, pushFailed = 0;
  const { rows: pendingOrders } = await pool.query(
    `SELECT * FROM orders WHERE delivery_date BETWEEN $1 AND $2 AND qb_invoice_id IS NULL
       AND (qb_push_in_progress_at IS NULL OR qb_push_in_progress_at < NOW() - INTERVAL '2 minutes')`,
    [from, to]
  );
  for (const order of pendingOrders) {
    try {
      await pushToQB(order);
      pushed++;
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`Reconcile: push failed for order ${order.id}:`, detail);
      pushFailed++;
    }
  }

  // applyOrderEdit pushes edits to QB synchronously, but doesn't roll back
  // the local edit if that push fails (the edit is real either way — see its
  // own comment). This is the automatic retry that closes the gap instead of
  // leaving a failed edit-sync stuck until someone manually re-saves it.
  let editRetried = 0, editRetryFailed = 0;
  const { rows: failedEdits } = await pool.query(
    `SELECT id FROM orders WHERE delivery_date BETWEEN $1 AND $2 AND qb_invoice_id IS NOT NULL AND push_attempts > 0
       AND (qb_push_in_progress_at IS NULL OR qb_push_in_progress_at < NOW() - INTERVAL '2 minutes')`,
    [from, to]
  );
  for (const { id } of failedEdits) {
    if (await retryOrderEditPush(id)) editRetried++; else editRetryFailed++;
  }

  let invoices;
  try {
    invoices = await queryQBInvoicesInRange(from, to);
  } catch (err) {
    if (err.message?.includes('Refresh token')) {
      return { error: 'QB token expired. Re-authorize at /api/auth/qb', status: 401 };
    }
    throw err;
  }

  let pulled = 0, updated = 0, unchanged = 0, voided = 0, skipped = 0;
  let linesAdded = 0, linesRemoved = 0, linesChanged = 0;
  for (const inv of invoices) {
    try {
      const result = await processInvoice(inv);
      if (result.status === 'created') pulled++;
      else if (result.status === 'updated') updated++;
      else if (result.status === 'unchanged') unchanged++;
      else if (result.status === 'voided') voided++;
      else skipped++;
      linesAdded += result.linesAdded || 0;
      linesRemoved += result.linesRemoved || 0;
      linesChanged += result.linesChanged || 0;
    } catch (err) {
      console.error(`Reconcile: failed to process QB invoice ${inv.Id}:`, err.message);
      skipped++;
    }
  }

  return {
    message: 'Reconciliation complete',
    from, to,
    pushed, pushFailed,
    editRetried, editRetryFailed,
    checked: invoices.length,
    pulled, updated, unchanged, voided, skipped,
    linesAdded, linesRemoved, linesChanged,
  };
}

// Orders the app holds that QuickBooks doesn't have an invoice for yet — same
// rule as syncPendingInvoices (no qb_invoice_id, at least one active line).
async function listUnpushedOrders() {
  const { rows } = await pool.query(
    `SELECT o.id, to_char(o.delivery_date, 'YYYY-MM-DD') AS delivery_date, o.total, o.source,
            o.order_placed_at, o.push_attempts, o.last_push_error, c.company_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.qb_invoice_id IS NULL
       AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.status = 'active')
     ORDER BY o.id`
  );
  return rows;
}

// GET /api/admin/invoice-number-recovery — read-only preview of what the
// recovery below would work on: the orders QuickBooks doesn't have, and where
// the invoice-number counter stands against QuickBooks' highest number.
async function previewInvoiceNumberRecovery(req, res) {
  let counter;
  try {
    counter = await docNumberCounterStatus();
  } catch (err) {
    if (err.message?.includes('Refresh token')) {
      return res.status(401).json({ error: 'QB token expired. Re-authorize at /api/auth/qb' });
    }
    throw err;
  }
  res.json({ counter, unpushed: await listUnpushedOrders() });
}

// POST /api/admin/invoice-number-recovery — for when invoices were created in
// QuickBooks while the app wasn't keeping up (outage, data migration), which
// leaves the invoice-number counter behind and every new push failing as a
// duplicate number. In order:
//  1. notes the orders QuickBooks doesn't have yet,
//  2. pulls the invoices QuickBooks has that the app doesn't,
//  3. moves the counter past QuickBooks' highest invoice number,
//  4. pushes the orders from step 1, which draw their numbers from the
//     corrected counter.
// The pull reaches back a week, or to the earliest unpushed order's delivery
// date if that is older (never past the 31 days orders are kept for).
async function runInvoiceNumberRecovery(req, res) {
  const unpushed = await listUnpushedOrders();

  const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
  const earliest = unpushed.map(o => o.delivery_date).sort()[0];
  let since = day(-7);
  if (earliest && earliest < since) since = earliest;
  if (since < day(-31)) since = day(-31);

  let invoices, counter;
  try {
    invoices = await queryQBInvoicesInRange(since, '2999-12-31');
  } catch (err) {
    if (err.message?.includes('Refresh token')) {
      return res.status(401).json({ error: 'QB token expired. Re-authorize at /api/auth/qb' });
    }
    throw err;
  }

  let pulled = 0, updated = 0, voided = 0, pullFailed = 0;
  for (const inv of invoices) {
    try {
      const result = await processInvoice(inv);
      if (result.status === 'created') pulled++;
      else if (result.status === 'updated') updated++;
      else if (result.status === 'voided') voided++;
    } catch (err) {
      console.error(`Invoice-number recovery: failed to process QB invoice ${inv.Id}:`, err.message);
      pullFailed++;
    }
  }

  counter = await raiseDocNumberCounter();

  const orders = [];
  for (const o of unpushed) {
    const entry = { id: o.id, company_name: o.company_name, delivery_date: o.delivery_date, total: o.total };
    try {
      // Re-read: the 20-minute sweep or the order's own first push may have got there meanwhile.
      const { rows: [order] } = await pool.query('SELECT * FROM orders WHERE id = $1', [o.id]);
      if (!order) {
        orders.push({ ...entry, status: 'failed', error: 'Order no longer exists' });
        continue;
      }
      if (!order.qb_invoice_id) await pushToQB(order);

      const { rows: [after] } = await pool.query(
        `SELECT o.qb_invoice_id, o.qb_doc_number,
                (SELECT COUNT(*) FROM orders o2 WHERE o2.qb_invoice_id = o.qb_invoice_id) > 1 AS merged
         FROM orders o WHERE o.id = $1`,
        [o.id]
      );
      if (after?.qb_invoice_id) {
        orders.push({ ...entry, status: 'pushed', qb_doc_number: after.qb_doc_number, merged: after.merged });
      } else {
        orders.push({ ...entry, status: 'failed', error: 'Another push of this order is in progress — check again in a few minutes' });
      }
    } catch (err) {
      const fault = err.response?.data?.Fault?.Error?.[0];
      console.error(`Invoice-number recovery: push failed for order ${o.id}:`, err.response?.data ? JSON.stringify(err.response.data) : err.message);
      orders.push({ ...entry, status: 'failed', error: fault ? (fault.Detail || fault.Message) : err.message });
    }
  }

  res.json({
    message: 'Invoice number recovery complete',
    since,
    counter,
    pull: { checked: invoices.length, pulled, updated, voided, failed: pullFailed },
    pushed: orders.filter(o => o.status === 'pushed').length,
    failed: orders.filter(o => o.status === 'failed').length,
    orders,
  });
}

module.exports = { syncFromQB, syncInvoicesFromQB, reconcileOrders, runReconciliation, refreshItemsFromQB, previewInvoiceNumberRecovery, runInvoiceNumberRecovery };

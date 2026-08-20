const pool = require('../config/db');
const { queryQBAll } = require('../middleware/qbSync');
const { processInvoice } = require('./webhooksController');
const { getQBClient } = require('../middleware/qbSync');
const { upsertQBItem, upsertQBCustomer } = require('../services/qbEntitySync');
const { pushToQB, retryOrderEditPush } = require('./ordersController');

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
    `SELECT * FROM orders WHERE delivery_date BETWEEN $1 AND $2 AND qb_invoice_id IS NULL`,
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
    `SELECT id FROM orders WHERE delivery_date BETWEEN $1 AND $2 AND qb_invoice_id IS NOT NULL AND push_attempts > 0`,
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

module.exports = { syncFromQB, syncInvoicesFromQB, reconcileOrders, runReconciliation };

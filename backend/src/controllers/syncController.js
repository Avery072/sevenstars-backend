const { queryQBAll } = require('../middleware/qbSync');
const { processInvoice } = require('./webhooksController');
const { getQBClient } = require('../middleware/qbSync');
const { upsertQBItem, upsertQBCustomer } = require('../services/qbEntitySync');

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

  let created = 0, updated = 0, skipped = 0;
  for (const inv of invoices) {
    try {
      const result = await processInvoice(inv);
      if (result === 'created') created++;
      else if (result === 'updated') updated++;
      else skipped++;
    } catch (err) {
      console.error(`Failed to sync QB invoice ${inv.Id}:`, err.message);
      skipped++;
    }
  }

  res.json({ message: 'Invoice sync complete', date: sinceStr, total: invoices.length, created, updated, skipped });
}

module.exports = { syncFromQB, syncInvoicesFromQB };

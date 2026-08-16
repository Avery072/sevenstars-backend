const pool = require('../config/db');
const { createQBInvoice, appendToQBInvoice, createQBCustomer, getQBClient, deleteQBInvoice, isDuplicateDocNumberError } = require('../middleware/qbSync');

async function nextQBDocNumber() {
  const { rows } = await pool.query("SELECT nextval('qb_invoice_doc_number_seq')::text AS n");
  return rows[0].n;
}

// Creates the invoice with a fresh DocNumber, retrying with a new one if QBO
// rejects it as a duplicate (e.g. a staff member created an invoice directly
// in QBO with the same number around the same time).
async function createQBInvoiceWithDocNumber(payload, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const docNumber = await nextQBDocNumber();
    try {
      return await createQBInvoice({ ...payload, DocNumber: docNumber });
    } catch (err) {
      if (attempt < attempts && isDuplicateDocNumberError(err)) {
        console.warn(`DocNumber ${docNumber} was already taken in QBO, retrying with a new one (attempt ${attempt}/${attempts})`);
        continue;
      }
      throw err;
    }
  }
}

async function listOrders(req, res) {
  const { date, from, to, customer_id } = req.query;

  const conditions = [];
  const params = [];

  if (from && to) {
    // Caller (admin portal date-range filter) computes from/to in local time
    // and passes plain YYYY-MM-DD strings — no timezone conversion happens here.
    params.push(from, to);
    conditions.push(`o.delivery_date BETWEEN $${params.length - 1} AND $${params.length}`);
  } else if (date) {
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
     WHERE oi.order_id = $1 AND oi.status = 'active'`,
    [id]
  );

  // Lines QB removed stay in the DB (soft-deleted) as an audit trail — surfaced
  // separately so the admin portal can show them struck-through if useful.
  const removedResult = await pool.query(
    `SELECT oi.*, p.sku, p.description
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1 AND oi.status = 'removed'`,
    [id]
  );

  res.json({ ...orderResult.rows[0], items: itemsResult.rows, removed_items: removedResult.rows });
}

async function createOrder(req, res) {
  const { customer_id, delivery_date, notes, items } = req.body;

  if (!customer_id || !delivery_date || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'customer_id, delivery_date, and items are required' });
  }

  // Look up prices and units from DB — client-sent prices are ignored
  const productIds = items.map(i => i.product_id);
  const prodResult = await pool.query(
    'SELECT id, price, unit, qb_item_id FROM products WHERE id = ANY($1) AND active = true',
    [productIds]
  );
  const productMap = Object.fromEntries(prodResult.rows.map(r => [r.id, r]));

  for (const item of items) {
    if (!productMap[item.product_id]) {
      return res.status(400).json({ error: `Product ${item.product_id} not found or inactive` });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await checkAndReserveStock(client, items);

    const newItemsTotal = items.reduce((sum, item) => {
      const p = productMap[item.product_id];
      return sum + parseFloat(item.quantity) * parseFloat(p.price || 0);
    }, 0);

    // Merge into existing order for same customer+delivery_date rather than creating a new row
    const existingOrder = await client.query(
      'SELECT id FROM orders WHERE customer_id = $1 AND delivery_date = $2 ORDER BY id ASC LIMIT 1',
      [customer_id, delivery_date]
    );

    let order;
    if (existingOrder.rows.length) {
      const orderId = existingOrder.rows[0].id;
      await client.query('UPDATE orders SET total = total + $1 WHERE id = $2', [newItemsTotal, orderId]);
      const updated = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      order = updated.rows[0];
    } else {
      const orderResult = await client.query(
        `INSERT INTO orders (customer_id, delivery_date, notes, total, original_total)
         VALUES ($1, $2, $3, $4, $4) RETURNING *`,
        [customer_id, delivery_date, notes, newItemsTotal]
      );
      order = orderResult.rows[0];
    }

    for (const item of items) {
      const p = productMap[item.product_id];
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit, unit_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, item.product_id, item.quantity, p.unit, p.price, item.notes || null]
      );
    }

    await client.query('COMMIT');

    // Push to QuickBooks async — don't block the response. The order is real
    // and committed regardless of whether this succeeds: the stock reservation
    // above stays held (not rolled back on failure) since the customer's order
    // is genuine and the goods are spoken for — only the QB *sync* failed, not
    // the order. pushToQB itself records the failure for visibility and
    // releases the reservation once a real invoice exists in QB. The order
    // stays pending (qb_invoice_id NULL) and can be retried via "SYNC PENDING
    // TO QB" / the discrepancy check.
    pushToQB(order, items).catch(err => {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`QB invoice push failed for order ${order.id}:`, detail);
    });

    res.status(201).json(order);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  } finally {
    client.release();
  }
}

// Checks stock and claims it for an order, all under row locks in the caller's
// transaction. products.reserved is the app's own column — quantity_on_hand is
// synced solely from QB (see qbEntitySync.js) so the two never race on the
// same value; available-to-sell is quantity_on_hand - reserved. Shared by
// createOrder (below) and the mobile order-placement route.
async function checkAndReserveStock(client, items) {
  const requestedByProduct = new Map();
  for (const item of items) {
    requestedByProduct.set(
      item.product_id,
      (requestedByProduct.get(item.product_id) || 0) + Number(item.quantity)
    );
  }

  for (const [productId, requestedQuantity] of requestedByProduct.entries()) {
    const stockResult = await client.query(
      'SELECT description, quantity_on_hand, reserved FROM products WHERE id = $1 FOR UPDATE',
      [productId]
    );
    const product = stockResult.rows[0];
    const available = Number(product.quantity_on_hand) - Number(product.reserved);

    if (available < requestedQuantity) {
      const err = new Error(`Insufficient stock for ${product.description}. Available: ${available}, Requested: ${requestedQuantity}`);
      err.status = 400;
      throw err;
    }
  }

  for (const [productId, requestedQuantity] of requestedByProduct.entries()) {
    await client.query('UPDATE products SET reserved = reserved + $1 WHERE id = $2', [requestedQuantity, productId]);
  }
}

// Releases an order's reservation (once its invoice is confirmed in QB, or
// when the order is deleted before that ever happens). Guarded by
// reservation_released_at so it's safe to call more than once — QB's own
// quantity_on_hand has already reflected the sale by the time an invoice
// exists, so releasing here (rather than waiting for the Item webhook) avoids
// double-counting against a webhook that hasn't arrived yet.
async function releaseReservation(dbClient, orderId) {
  const orderResult = await dbClient.query('SELECT reservation_released_at FROM orders WHERE id = $1', [orderId]);
  if (!orderResult.rows.length || orderResult.rows[0].reservation_released_at) return;

  const items = await dbClient.query(
    `SELECT product_id, quantity FROM order_items WHERE order_id = $1 AND status = 'active'`,
    [orderId]
  );
  const byProduct = new Map();
  for (const item of items.rows) {
    byProduct.set(item.product_id, (byProduct.get(item.product_id) || 0) + Number(item.quantity));
  }
  for (const [productId, qty] of byProduct.entries()) {
    await dbClient.query('UPDATE products SET reserved = reserved - $1 WHERE id = $2', [qty, productId]);
  }
  await dbClient.query('UPDATE orders SET reservation_released_at = NOW() WHERE id = $1', [orderId]);
}

// Visibility for stuck pushes — the admin portal flags orders pending past a
// threshold with attempts > 0 as "stuck", distinct from orders merely waiting
// on their first (near-instant) push attempt.
async function recordPushFailure(orderId, err) {
  const detail = (err.response?.data ? JSON.stringify(err.response.data) : err.message || String(err)).slice(0, 2000);
  await pool.query(
    `UPDATE orders SET push_attempts = push_attempts + 1, last_push_error = $1, last_push_attempt_at = NOW() WHERE id = $2`,
    [detail, orderId]
  );
}

// Thin wrapper so every caller (createOrder, the mobile order route,
// syncPendingInvoices, reconcileOrders) gets the same failure-visibility and
// reservation-release behavior without duplicating it at each call site.
async function pushToQB(order, items) {
  try {
    await pushToQBInner(order, items);
    await releaseReservation(pool, order.id);
  } catch (err) {
    await recordPushFailure(order.id, err).catch(recErr =>
      console.error(`Order ${order.id}: failed to record push failure:`, recErr.message)
    );
    throw err;
  }
}

async function pushToQBInner(order, items) {
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

  let invoiceId, docNumber, respInvoice;
  if (existing.rows.length) {
    try {
      const updated = await appendToQBInvoice(existing.rows[0].qb_invoice_id, lines);
      invoiceId = updated.Id;
      docNumber = updated.DocNumber;
      respInvoice = updated;
      console.log(`QB invoice #${docNumber} (id ${invoiceId}) updated — merged order ${order.id} into existing invoice`);
    } catch (appendErr) {
      console.warn(`QB invoice ${existing.rows[0].qb_invoice_id} unreachable (deleted/voided in QB), creating new invoice. Error: ${appendErr.message}`);
      await pool.query('UPDATE orders SET qb_invoice_id = NULL, qb_doc_number = NULL WHERE qb_invoice_id = $1', [existing.rows[0].qb_invoice_id]);
      const payload = {
        CustomerRef: { value: qbCustomerId },
        TxnDate: order.delivery_date,
        Line: lines,
        ...(order.notes ? { CustomerMemo: { value: order.notes } } : {}),
      };
      const invoice = await createQBInvoiceWithDocNumber(payload);
      invoiceId = invoice.Id;
      docNumber = invoice.DocNumber;
      respInvoice = invoice;
      console.log(`QB invoice #${docNumber} (id ${invoiceId}) created (fallback) for order ${order.id}`);
    }
  } else {
    const payload = {
      CustomerRef: { value: qbCustomerId },
      TxnDate: order.delivery_date,
      Line: lines,
      ...(order.notes ? { CustomerMemo: { value: order.notes } } : {}),
    };
    const invoice = await createQBInvoiceWithDocNumber(payload);
    invoiceId = invoice.Id;
    docNumber = invoice.DocNumber;
    respInvoice = invoice;
    console.log(`QB invoice #${docNumber} (id ${invoiceId}) created for order ${order.id}`);
  }

  await pool.query('UPDATE orders SET qb_invoice_id = $1, qb_doc_number = $2 WHERE id = $3', [invoiceId, docNumber, order.id]);

  // Backfill qb_line_id on the order_items this call just pushed, so future QB
  // edits to these specific lines can be reconciled by line id instead of guessing
  // by product_id (which breaks if a product appears as two separate lines, or a
  // line's item gets swapped in QB). For a plain create, every response line is
  // new; for an append, the newly-added lines are the last `lines.length` entries.
  const respLines = (respInvoice.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail');
  const newLines = respLines.slice(-lines.length);
  const { rows: unbackfilled } = await pool.query(
    `SELECT id FROM order_items WHERE order_id = $1 AND qb_line_id IS NULL ORDER BY id ASC`,
    [order.id]
  );
  for (let i = 0; i < unbackfilled.length && i < newLines.length; i++) {
    await pool.query('UPDATE order_items SET qb_line_id = $1 WHERE id = $2', [newLines[i].Id, unbackfilled[i].id]);
  }
}

async function deleteOrder(req, res) {
  const { id } = req.params;
  const client = await pool.connect();
  let qb_invoice_id;

  try {
    await client.query('BEGIN');

    const lookup = await client.query('SELECT qb_invoice_id FROM orders WHERE id = $1', [id]);
    if (!lookup.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    qb_invoice_id = lookup.rows[0].qb_invoice_id;

    // Releases the reservation if the order's push to QB never succeeded (a
    // no-op if it already did — QB's own quantity_on_hand already reflects the
    // sale by then, and deleteQBInvoice below tells QB about the cancellation,
    // which flows back through the Item webhook as usual).
    await releaseReservation(client, id);

    await client.query('DELETE FROM orders WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (qb_invoice_id) {
    deleteQBInvoice(qb_invoice_id).catch(err =>
      console.warn(`QB invoice ${qb_invoice_id} delete failed (may already be voided):`, err.message)
    );
  }

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
     WHERE o.delivery_date = COALESCE($1::date, CURRENT_DATE) AND oi.status = 'active'
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

async function getSalmonPullReport(req, res) {
  const date = req.query.date || null;
  const result = await pool.query(
    `SELECT
       p.id AS product_id,
       p.sku,
       p.description,
       c.company_name,
       SUM(oi.quantity)::float AS quantity,
       oi.unit,
       c.salmon_cut,
       c.skin_off,
       c.scale,
       c.pbo,
       c.hg,
       COALESCE(string_agg(DISTINCT NULLIF(oi.notes, ''), '; '), '') AS notes
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN products p ON p.id = oi.product_id
     JOIN customers c ON c.id = o.customer_id
     WHERE o.delivery_date = COALESCE($1::date, CURRENT_DATE)
       AND p.description ILIKE '%salmon%' AND oi.status = 'active'
     GROUP BY p.id, p.sku, p.description, c.company_name, oi.unit,
              c.salmon_cut, c.skin_off, c.scale, c.pbo, c.hg
     ORDER BY p.description ASC, c.company_name ASC`,
    [date]
  );

  const products = [];
  const productMap = new Map();

  for (const row of result.rows) {
    const key = row.product_id;
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
      sku: row.sku,
      description: row.description,
      company_name: row.company_name,
      quantity: Number(row.quantity || 0),
      unit: row.unit,
      salmon_cut: row.salmon_cut,
      skin_off: row.skin_off,
      scale: row.scale,
      pbo: row.pbo,
      hg: row.hg,
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
     WHERE o.qb_invoice_id IS NULL AND oi.status = 'active'
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

// Deletes orders (and their line items via CASCADE) older than ~1 month.
// Kept at 31 days (not 30) so the admin's "past month" filter (rolling 30
// days) never loses data right at its own edge.
async function purgeOldOrders() {
  const result = await pool.query(
    `DELETE FROM orders WHERE delivery_date < CURRENT_DATE - INTERVAL '31 days'`
  );
  if (result.rowCount > 0) {
    console.log(`Purged ${result.rowCount} order(s) older than 31 days`);
  }
}

module.exports = { listOrders, getOrder, createOrder, deleteOrder, getPackingReport, getSalmonPullReport, syncPendingInvoices, purgeOldOrders, pushToQB, checkAndReserveStock };

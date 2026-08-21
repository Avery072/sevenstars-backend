const pool = require('../config/db');
const { createQBInvoice, appendToQBInvoice, patchQBInvoiceLines, createQBCustomer, getQBClient, deleteQBInvoice, isDuplicateDocNumberError } = require('../middleware/qbSync');

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
        `INSERT INTO orders (customer_id, delivery_date, notes, total, original_total, source)
         VALUES ($1, $2, $3, $4, $4, 'admin') RETURNING *`,
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
    pushToQB(order).catch(err => {
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

// Resets the failure counter on a successful push — without this, an order
// that failed once and later succeeded (e.g. a transient network blip,
// retried) would show push_attempts > 0 forever, which the admin portal
// would misread as a still-unresolved failure.
async function clearPushFailure(orderId) {
  await pool.query(
    `UPDATE orders SET push_attempts = 0, last_push_error = NULL WHERE id = $1`,
    [orderId]
  );
}

// Internal-only note (not customer-visible) marking where an invoice's order
// originated, so a salesperson looking at it directly in QuickBooks can tell
// at a glance it wasn't entered by another salesperson before editing it
// there. Compatible with isVoided()'s PrivateNote check above — QBO
// *prepends* "Voided" to whatever's already in the field, so this text
// doesn't interfere with that regardless of what's already there.
function originPrivateNote(source) {
  if (source === 'mobile') return 'Submitted via App';
  if (source === 'admin') return 'Submitted via Admin Dashboard';
  return undefined; // qb-origin orders are already obvious to whoever entered them there
}

// Thin wrapper so every caller (createOrder, the mobile order route,
// syncPendingInvoices, reconcileOrders) gets the same failure-visibility and
// reservation-release behavior without duplicating it at each call site.
async function pushToQB(order) {
  // Same guard as pushOrderEditToQB, and for the same reason — this covers
  // creation too because a *merge* (second+ order for the same customer/day)
  // pushes to an invoice that already exists, which reconciliation can find
  // and touch just like an edited order can. A brand-new order has no
  // qb_invoice_id yet, so the guard is inert for it (reconciliation can't
  // find an order it can't match), but setting it unconditionally here is
  // simpler than branching on whether this happens to be a merge.
  await pool.query('UPDATE orders SET qb_push_in_progress_at = NOW() WHERE id = $1', [order.id]);
  try {
    await pushToQBInner(order);
    await releaseReservation(pool, order.id);
    await clearPushFailure(order.id);
  } catch (err) {
    await recordPushFailure(order.id, err).catch(recErr =>
      console.error(`Order ${order.id}: failed to record push failure:`, recErr.message)
    );
    throw err;
  } finally {
    await pool.query('UPDATE orders SET qb_push_in_progress_at = NULL WHERE id = $1', [order.id]);
  }
}

// Builds QB Line[] entries from this order's not-yet-pushed active items,
// read fresh from the DB rather than trusted from an argument — closes a
// race where an edit landing in the split second before this resolves would
// otherwise push stale data. Deliberately filtered to qb_line_id IS NULL
// (not all active items): this function is delta-based by design, since the
// existing-invoice branch below appends whatever it's given onto whatever's
// already in QB — pushing already-pushed lines again would duplicate them.
async function unpushedOrderLines(orderId) {
  const itemsResult = await pool.query(
    `SELECT oi.id, oi.quantity, oi.unit_price, oi.notes, p.qb_item_id, p.price, p.description
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1 AND oi.status = 'active' AND oi.qb_line_id IS NULL
     ORDER BY oi.id ASC`,
    [orderId]
  );

  const noQbId = itemsResult.rows.filter(i => !i.qb_item_id);
  if (noQbId.length) {
    console.warn(`Order ${orderId}: skipping ${noQbId.length} item(s) with no qb_item_id`);
  }

  // unit_price here should prefer the current product price the same way
  // buildQBLine's callers do, so this stays consistent with the edit path.
  return itemsResult.rows
    .filter(item => item.qb_item_id)
    .map(item => buildQBLine({ ...item, unit_price: item.price ?? item.unit_price }));
}

async function pushToQBInner(order) {
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

  const lines = await unpushedOrderLines(order.id);
  if (!lines.length) throw new Error(`No QB-linked items on order ${order.id} — run Sync from QB to populate qb_item_id on products`);

  const privateNote = originPrivateNote(order.source);

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
        ...(privateNote ? { PrivateNote: privateNote } : {}),
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
      ...(privateNote ? { PrivateNote: privateNote } : {}),
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
    `SELECT id FROM order_items WHERE order_id = $1 AND status = 'active' AND qb_line_id IS NULL ORDER BY id ASC`,
    [order.id]
  );
  for (let i = 0; i < unbackfilled.length && i < newLines.length; i++) {
    await pool.query('UPDATE order_items SET qb_line_id = $1 WHERE id = $2', [newLines[i].Id, unbackfilled[i].id]);
  }
}

// Applies a full-replacement item-list edit to an existing order: diffs
// against current active order_items, adjusts products.reserved for the
// delta, applies the diff, and (if the order already has a confirmed QB
// invoice) pushes the change to QB. Shared by the mobile customer-edit route
// and the admin edit route so the logic can't fork the way the mobile/admin
// QB-push logic already has once in this codebase.
//
// Reservation nuance: once an order's reservation has been released
// (releaseReservation, once its QB invoice is confirmed), `reserved` no
// longer holds anything for this order — QB's own quantity_on_hand is
// assumed to already reflect the original sale. So for an already-released
// order, only quantity *increases* get a fresh stock-check-and-reserve (new
// demand against current stock); decreases/removals need no reserved
// adjustment at all, since there's nothing locally reserved to give back —
// the correction flows back automatically once the smaller invoice syncs
// QB's own quantity_on_hand down through the normal Item webhook.
async function applyOrderEdit(order, newItems) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const currentResult = await client.query(
      `SELECT id, product_id, quantity, unit_price, qb_line_id
       FROM order_items WHERE order_id = $1 AND status = 'active'
       ORDER BY id ASC`,
      [order.id]
    );
    const current = currentResult.rows;
    // Grouped into arrays, not a 1:1 Map — a product can legitimately have
    // more than one active line (two same-day orders for the same product
    // merge into two separate order_items rows, not one summed row). A
    // straight `new Map(rows.map(r => [r.product_id, r]))` would silently
    // keep only the last row seen per product and orphan the rest —
    // reconcileExistingOrder avoids exactly this by matching on qb_line_id
    // instead of product_id; this needs the same care.
    const currentByProduct = new Map();
    for (const row of current) {
      if (!currentByProduct.has(row.product_id)) currentByProduct.set(row.product_id, []);
      currentByProduct.get(row.product_id).push(row);
    }

    const newByProduct = new Map();
    for (const item of newItems) {
      newByProduct.set(item.product_id, (newByProduct.get(item.product_id) || 0) + Number(item.quantity));
    }

    const productIds = [...newByProduct.keys()];
    const prodResult = await client.query(
      'SELECT id, price, unit, qb_item_id FROM products WHERE id = ANY($1) AND active = true',
      [productIds]
    );
    const productMap = Object.fromEntries(prodResult.rows.map(r => [r.id, r]));
    for (const productId of newByProduct.keys()) {
      if (!productMap[productId]) {
        const err = new Error(`Product ${productId} not found or inactive`);
        err.status = 400;
        throw err;
      }
    }

    // Lock every product this edit touches (union of current + new), in a
    // stable ascending order — matches checkAndReserveStock's existing
    // locking pattern, avoiding new deadlock risk between concurrent
    // edits/creates touching overlapping products.
    const allProductIds = [...new Set([...currentByProduct.keys(), ...newByProduct.keys()])].sort((a, b) => a - b);
    const lockedProducts = new Map();
    for (const productId of allProductIds) {
      const { rows } = await client.query(
        'SELECT id, description, quantity_on_hand, reserved FROM products WHERE id = $1 FOR UPDATE',
        [productId]
      );
      lockedProducts.set(productId, rows[0]);
    }

    const released = !!order.reservation_released_at;

    for (const productId of allProductIds) {
      const before = (currentByProduct.get(productId) || []).reduce((sum, r) => sum + Number(r.quantity), 0);
      const after = newByProduct.get(productId) || 0;
      const delta = after - before;
      if (Math.abs(delta) <= 0.0001) continue;

      const product = lockedProducts.get(productId);

      if (delta > 0) {
        const available = Number(product.quantity_on_hand) - Number(product.reserved);
        if (available < delta) {
          const err = new Error(`Insufficient stock for ${product.description}. Available: ${available}, Requested additional: ${delta}`);
          err.status = 400;
          throw err;
        }
        await client.query('UPDATE products SET reserved = reserved + $1 WHERE id = $2', [delta, productId]);
      } else if (!released) {
        await client.query('UPDATE products SET reserved = reserved + $1 WHERE id = $2', [delta, productId]); // delta is negative
      }
    }

    for (const row of current) {
      if (!newByProduct.has(row.product_id)) {
        await client.query(`UPDATE order_items SET status = 'removed' WHERE id = $1`, [row.id]);
      }
    }
    for (const [productId, quantity] of newByProduct.entries()) {
      const p = productMap[productId];
      const existingRows = currentByProduct.get(productId) || [];

      if (!existingRows.length) {
        const itemNotes = newItems.find(i => i.product_id === productId)?.notes || null;
        await client.query(
          `INSERT INTO order_items (order_id, product_id, quantity, unit, unit_price, notes, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
          [order.id, productId, quantity, p.unit, p.price, itemNotes]
        );
        continue;
      }

      const currentTotal = existingRows.reduce((sum, r) => sum + Number(r.quantity), 0);
      // Tolerance, not strict equality — quantities can be fractional
      // (weight-based fish), same pattern reconcileExistingOrder already
      // uses for its own line-changed check.
      if (Math.abs(currentTotal - quantity) <= 0.0001) continue; // genuinely untouched — leave every row, including duplicates, exactly as-is

      // The edit API can only ever express one target quantity per product
      // (newByProduct is itself a sum, never per-line), so there's no way
      // for a caller to say "keep these as two distinct lines" once one of
      // them changes. Consolidate onto the oldest row (most likely to
      // already carry a qb_line_id, so the QB push updates it in place
      // rather than removing+re-adding) and soft-remove any others for this
      // product — instead of the old behavior, which touched an arbitrary
      // one and silently orphaned the rest.
      const [primary, ...extras] = existingRows;
      // qb_dirty marks this line as needing a QB push — durable, so a
      // retry after a failed push (possibly on a fresh process) knows
      // exactly which lines to patch without re-diffing against QB's
      // live state, which would be ambiguous (see patchQBInvoiceLines).
      await client.query(
        'UPDATE order_items SET quantity = $1, unit_price = $2, unit = $3, qb_dirty = (qb_line_id IS NOT NULL) WHERE id = $4',
        [quantity, p.price, p.unit, primary.id]
      );
      for (const extra of extras) {
        await client.query(
          `UPDATE order_items SET status = 'removed', qb_dirty = FALSE WHERE id = $1`,
          [extra.id]
        );
      }
    }

    const newTotal = [...newByProduct.entries()].reduce(
      (sum, [productId, qty]) => sum + qty * parseFloat(productMap[productId].price || 0),
      0
    );
    await client.query(`UPDATE orders SET total = $1, status = 'modified' WHERE id = $2`, [newTotal, order.id]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Pushed synchronously (unlike order creation, which is deliberately
  // fire-and-forget) — an edit modifies an *existing* invoice that the
  // periodic reconciliation sweep also polls, so an async gap here is a real
  // lost-update window: if reconciliation's QB fetch lands between our local
  // commit above and this push landing, it would see QB's pre-edit state and
  // (correctly, per reconcileExistingOrder's design) treat it as ground
  // truth, silently discarding the edit that was just made. Awaiting the
  // push closes that window — by the time this function returns, QB and
  // local either agree, or the caller knows they don't (see qbSynced below).
  let qbSynced = true;
  if (order.qb_invoice_id) {
    try {
      await pushOrderEditToQB(order.id);
      await clearPushFailure(order.id);
    } catch (err) {
      qbSynced = false;
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`QB invoice line update failed for order ${order.id}:`, detail);
      await recordPushFailure(order.id, err).catch(recErr =>
        console.error(`Order ${order.id}: failed to record push failure:`, recErr.message)
      );
    }
  }
  // The local edit is real and stays committed either way (matching
  // pushToQB's own philosophy — see its comment on createOrder) — a QB sync
  // failure here doesn't invalidate the customer/admin's edit, but the
  // caller needs to know QB hasn't caught up yet so it can be retried.
  return { qbSynced };
}

// Retries a previously-failed push to an *already-invoiced* order — covers
// both a failed edit push (applyOrderEdit pushes synchronously but doesn't
// roll back the local edit on QB failure) and a failed merge-append (a
// second same-day order whose new lines never made it into the existing
// invoice — pushToQB failed after qb_invoice_id was already set from the
// first order that day, so it isn't caught by the qb_invoice_id IS NULL
// retry loop in runReconciliation). Both leave the same signature —
// order_items with qb_line_id IS NULL on an order that already has an
// invoice — which is exactly what pushOrderEditToQB's addLines query looks
// for, so one retry path naturally covers both failure modes. Used by the
// periodic reconciliation job, same failure-visibility pattern as pushToQB.
async function retryOrderEditPush(orderId) {
  try {
    await pushOrderEditToQB(orderId);
    await clearPushFailure(orderId);
    return true;
  } catch (err) {
    await recordPushFailure(orderId, err).catch(recErr =>
      console.error(`Order ${orderId}: failed to record push failure:`, recErr.message)
    );
    return false;
  }
}

// Builds a line payload from an order_items row for the QB API.
//
// Description was never being set here at all — QBO's own UI auto-fills a
// line's description when a human picks an item, but that's a UI
// convenience, not something the API does for you on a bare POST. Every
// order placed through the app/admin was silently shipping invoice lines
// with no description as a result (reported: invoice 34821, FKING-WHITE and
// FSMKSAL had none, vs. 34826 created directly in QBO's UI with the same
// products, which did). Falls back through order_items.notes (matches the
// pull direction, which already treats a QB line's Description as
// equivalent to notes — see processInvoice's insert) to the product's own
// catalog description, so every line gets *something* even when no
// per-line note was ever entered.
function buildQBLine(item) {
  const qty = parseFloat(item.quantity);
  const unitPrice = parseFloat(item.unit_price || 0);
  const description = item.notes || item.description || undefined;
  return {
    ...(item.qb_line_id ? { Id: item.qb_line_id } : {}),
    ...(description ? { Description: description } : {}),
    Amount: qty * unitPrice,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: item.qb_item_id },
      Qty: qty,
      UnitPrice: unitPrice,
    },
  };
}

// Pushes exactly what's changed on an edited order to its existing QB
// invoice — removed lines, lines marked qb_dirty (quantity/price changed
// locally), and never-yet-pushed lines (qb_line_id IS NULL) — via a targeted
// patchQBInvoiceLines call, not a blind full resend. Sourcing "what to push"
// from qb_dirty/qb_line_id (durable DB state) rather than an in-memory diff
// means this also works correctly as a retry, on a fresh process, after a
// failed push — see retryOrderEditPush.
//
// Guarded by orders.qb_push_in_progress_at against reconciliation
// interleaving mid-push: reconcileExistingOrder skips an order with this set
// recently, so it can't grab QB's pre-push state and undo what's about to
// land. Cleared in `finally` regardless of outcome — the guard only needs to
// cover the actual QB round-trip, not the retry cadence.
async function pushOrderEditToQB(orderId) {
  const orderResult = await pool.query('SELECT qb_invoice_id FROM orders WHERE id = $1', [orderId]);
  const qbInvoiceId = orderResult.rows[0]?.qb_invoice_id;
  if (!qbInvoiceId) return;

  const [removedResult, dirtyResult, newResult] = await Promise.all([
    pool.query(
      `SELECT qb_line_id FROM order_items WHERE order_id = $1 AND status = 'removed' AND qb_line_id IS NOT NULL`,
      [orderId]
    ),
    pool.query(
      `SELECT oi.id, oi.qb_line_id, oi.quantity, oi.unit_price, oi.notes, p.qb_item_id, p.description
       FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1 AND oi.status = 'active' AND oi.qb_dirty = TRUE AND oi.qb_line_id IS NOT NULL`,
      [orderId]
    ),
    pool.query(
      `SELECT oi.id, oi.quantity, oi.unit_price, oi.notes, p.qb_item_id, p.description
       FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1 AND oi.status = 'active' AND oi.qb_line_id IS NULL
       ORDER BY oi.id ASC`,
      [orderId]
    ),
  ]);

  const removeLineIds = removedResult.rows.map(r => r.qb_line_id);
  const dirtyRows = dirtyResult.rows.filter(r => r.qb_item_id);
  const newRows = newResult.rows.filter(r => r.qb_item_id);
  const skipped = dirtyResult.rows.length - dirtyRows.length + (newResult.rows.length - newRows.length);
  if (skipped) {
    console.warn(`Order ${orderId}: skipping ${skipped} item(s) with no qb_item_id on QB update`);
  }

  const updateLines = dirtyRows.map(buildQBLine);
  const addLines = newRows.map(buildQBLine);

  if (!removeLineIds.length && !updateLines.length && !addLines.length) return; // nothing pending

  await pool.query('UPDATE orders SET qb_push_in_progress_at = NOW() WHERE id = $1', [orderId]);
  let updatedInvoice;
  try {
    updatedInvoice = await patchQBInvoiceLines(qbInvoiceId, { removeLineIds, updateLines, addLines });
  } finally {
    await pool.query('UPDATE orders SET qb_push_in_progress_at = NULL WHERE id = $1', [orderId]);
  }

  if (dirtyRows.length) {
    await pool.query(
      `UPDATE order_items SET qb_dirty = FALSE WHERE id = ANY($1)`,
      [dirtyRows.map(r => r.id)]
    );
  }

  if (newRows.length) {
    const respLines = (updatedInvoice.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail');
    const newRespLines = respLines.slice(-newRows.length);
    for (let i = 0; i < newRows.length && i < newRespLines.length; i++) {
      await pool.query('UPDATE order_items SET qb_line_id = $1 WHERE id = $2', [newRespLines[i].Id, newRows[i].id]);
    }
  }
}

// PATCH /api/orders/:id — admin edit. No ownership check (admin may edit any
// customer's order). Same 2am-on-delivery-date cutoff as the customer-facing
// mobile endpoint — no exemption for staff (deliberate, not an oversight):
// our system owns an order until that cutoff, QuickBooks owns it after,
// full stop. That clean handoff is what makes the whole qb_dirty /
// qb_push_in_progress_at / patchQBInvoiceLines machinery in applyOrderEdit
// defense-in-depth rather than load-bearing — with no exemption, our system
// and QB are never both trying to write the same order at the same time
// during normal operation. A day-of phone-in change now goes through
// QuickBooks directly, same as any qb-origin order. Only QB-origin orders
// are off-limits here regardless of timing — those are edited in
// QuickBooks only, always.
async function editOrder(req, res) {
  const { id } = req.params;
  const { items } = req.body;

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'items are required' });
  }

  const orderResult = await pool.query(
    `SELECT *, (NOW() > ((delivery_date::timestamp + INTERVAL '2 hours') AT TIME ZONE 'America/Los_Angeles')) AS past_edit_cutoff
     FROM orders WHERE id = $1`,
    [id]
  );
  if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
  const order = orderResult.rows[0];

  if (order.source === 'qb') {
    return res.status(403).json({ error: 'Orders entered directly in QuickBooks can only be edited there' });
  }
  if (order.status === 'voided') {
    return res.status(400).json({ error: 'Cannot edit a voided order' });
  }
  if (order.past_edit_cutoff) {
    return res.status(400).json({ error: 'The edit window for this order has closed — make the change directly in QuickBooks.' });
  }

  let qbSynced = true;
  try {
    ({ qbSynced } = await applyOrderEdit(order, items));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    throw err;
  }

  const updated = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  res.json({ ...updated.rows[0], qb_synced: qbSynced });
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
    `SELECT DISTINCT o.*
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.qb_invoice_id IS NULL AND oi.status = 'active'
     ORDER BY o.id`
  );

  if (!orders.length) return res.json({ message: 'No pending invoices', synced: 0, failed: 0 });

  let synced = 0, failed = 0;
  for (const order of orders) {
    try {
      await pushToQB(order);
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

module.exports = { listOrders, getOrder, createOrder, editOrder, applyOrderEdit, deleteOrder, getPackingReport, getSalmonPullReport, syncPendingInvoices, purgeOldOrders, pushToQB, retryOrderEditPush, checkAndReserveStock };

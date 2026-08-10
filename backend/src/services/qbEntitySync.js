const pool = require('../config/db');

const ITEM_FIELDS = ['qb_item_id', 'sku', 'description', 'category', 'unit', 'price', 'cost', 'active'];
const CUSTOMER_FIELDS = ['company_name', 'first_name', 'last_name', 'phone', 'email', 'active'];

function diffFields(existing, incoming, fields) {
  const changes = {};
  for (const field of fields) {
    const oldVal = existing[field] ?? null;
    const newVal = incoming[field] ?? null;
    const oldCmp = typeof oldVal === 'number' ? oldVal : String(oldVal ?? '');
    const newCmp = typeof newVal === 'number' ? newVal : String(newVal ?? '');
    if (oldCmp !== newCmp) changes[field] = { from: oldVal, to: newVal };
  }
  return changes;
}

// Upserts a single QB Item into products. Matches by qb_item_id first; if none,
// links a locally-created product with the same SKU that has no qb_item_id yet
// (rather than creating a duplicate row). Defaults unit to the item's own
// UnitOfMeasure, falling back to 'ea' only if QB didn't supply one.
// Returns { status: 'created'|'updated', sku, description, changes? } or
// null if the item already matches an existing row exactly (nothing to do).
async function upsertQBItem(item) {
  const incoming = {
    qb_item_id: item.Id,
    sku: item.Name,
    description: item.Description || item.Name,
    // QB only nests an item under a category when SubItem is true — ParentRef
    // can be present-but-irrelevant otherwise, so gate on SubItem explicitly
    // rather than just checking for ParentRef's existence.
    category: item.SubItem ? (item.ParentRef?.name || null) : null,
    unit: item.UnitOfMeasure || 'ea',
    price: Number(item.UnitPrice || 0),
    cost: Number(item.PurchaseCost || 0),
    active: item.Active !== false,
  };

  const existingResult = await pool.query(
    `SELECT id, qb_item_id, sku, description, category, unit, price, cost, active
     FROM products
     WHERE qb_item_id = $1 OR (qb_item_id IS NULL AND LOWER(sku) = LOWER($2))
     ORDER BY qb_item_id NULLS LAST
     LIMIT 1`,
    [incoming.qb_item_id, incoming.sku]
  );

  if (!existingResult.rows.length) {
    await pool.query(
      `INSERT INTO products (qb_item_id, sku, description, category, unit, price, cost, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [incoming.qb_item_id, incoming.sku, incoming.description, incoming.category, incoming.unit, incoming.price, incoming.cost, incoming.active]
    );
    return { status: 'created', sku: incoming.sku, description: incoming.description };
  }

  const existing = existingResult.rows[0];
  const changes = diffFields(existing, incoming, ITEM_FIELDS);
  if (!Object.keys(changes).length) return null;

  // Never overwrite an existing category with NULL — e.g. an item the CSV
  // import already categorized but that isn't SubItem-nested in QB yet
  // (see category_migration.md Phase 0 findings). QB-sourced categorization
  // is only ever additive/corrective here, never destructive.
  const nextCategory = incoming.category !== null ? incoming.category : existing.category;
  if (nextCategory !== existing.category) {
    changes.category = { from: existing.category, to: nextCategory };
  } else {
    delete changes.category;
  }
  if (!Object.keys(changes).length) return null;

  await pool.query(
    `UPDATE products
     SET qb_item_id = $1, sku = $2, description = $3, category = $4, unit = $5, price = $6, cost = $7, active = $8, updated_at = NOW()
     WHERE id = $9`,
    [incoming.qb_item_id, incoming.sku, incoming.description, nextCategory, incoming.unit, incoming.price, incoming.cost, incoming.active, existing.id]
  );

  return { status: 'updated', sku: incoming.sku, description: incoming.description, changes };
}

// Upserts a single QB Customer into customers, matched by qb_customer_id.
// Returns { status, name, changes? } or null if nothing actually changed.
async function upsertQBCustomer(c) {
  const incoming = {
    qb_customer_id: c.Id,
    company_name: c.CompanyName || `${c.GivenName || ''} ${c.FamilyName || ''}`.trim() || c.DisplayName,
    first_name: c.GivenName || null,
    last_name: c.FamilyName || null,
    phone: c.PrimaryPhone?.FreeFormNumber || null,
    email: c.PrimaryEmailAddr?.Address || null,
    active: c.Active !== false,
  };

  const existingResult = await pool.query(
    `SELECT id, company_name, first_name, last_name, phone, email, active
     FROM customers WHERE qb_customer_id = $1`,
    [incoming.qb_customer_id]
  );

  if (!existingResult.rows.length) {
    await pool.query(
      `INSERT INTO customers (qb_customer_id, company_name, first_name, last_name, phone, email, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [incoming.qb_customer_id, incoming.company_name, incoming.first_name, incoming.last_name, incoming.phone, incoming.email, incoming.active]
    );
    return { status: 'created', name: incoming.company_name };
  }

  const existing = existingResult.rows[0];
  const changes = diffFields(existing, incoming, CUSTOMER_FIELDS);
  if (!Object.keys(changes).length) return null;

  await pool.query(
    `UPDATE customers SET company_name = $1, first_name = $2, last_name = $3, phone = $4, email = $5, active = $6
     WHERE id = $7`,
    [incoming.company_name, incoming.first_name, incoming.last_name, incoming.phone, incoming.email, incoming.active, existing.id]
  );

  return { status: 'updated', name: incoming.company_name, changes };
}

module.exports = { upsertQBItem, upsertQBCustomer };

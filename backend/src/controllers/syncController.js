const pool = require('../config/db');
const { queryQBAll } = require('../middleware/qbSync');

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

  const [itemCount, customerCount] = await Promise.all([
    upsertItems(items),
    upsertCustomers(customers),
  ]);

  res.json({
    message: 'Sync complete',
    items_synced: itemCount,
    customers_synced: customerCount,
  });
}

async function upsertItems(items) {
  let count = 0;
  for (const item of items) {
    if (item.Type === 'Category' || item.Type === 'Group') continue;

    const vals = [
      item.Id,
      item.Name,
      item.Description || item.Name,
      item.UnitOfMeasure || 'ea',
      item.UnitPrice || 0,
      item.PurchaseCost || 0,
      item.Active !== false,
    ];

    // If a locally-created product exists with the same SKU but no QB ID yet,
    // link it rather than creating a duplicate row.
    const linked = await pool.query(
      `UPDATE products
       SET qb_item_id = $1, description = $3, unit = $4,
           price = $5, cost = $6, active = $7, updated_at = NOW()
       WHERE LOWER(sku) = LOWER($2)
         AND qb_item_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM products WHERE qb_item_id = $1)
       RETURNING id`,
      vals
    );

    if (!linked.rows.length) {
      await pool.query(
        `INSERT INTO products (qb_item_id, sku, description, unit, price, cost, active, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (qb_item_id) DO UPDATE
           SET sku         = EXCLUDED.sku,
               description = EXCLUDED.description,
               unit        = EXCLUDED.unit,
               price       = EXCLUDED.price,
               cost        = EXCLUDED.cost,
               active      = EXCLUDED.active,
               updated_at  = NOW()`,
        vals
      );
    }
    count++;
  }
  return count;
}

async function upsertCustomers(customers) {
  let count = 0;
  for (const c of customers) {
    await pool.query(
      `INSERT INTO customers (qb_customer_id, company_name, first_name, last_name, phone, email, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (qb_customer_id) DO UPDATE
         SET company_name = EXCLUDED.company_name,
             first_name   = EXCLUDED.first_name,
             last_name    = EXCLUDED.last_name,
             phone        = EXCLUDED.phone,
             email        = EXCLUDED.email,
             active       = EXCLUDED.active`,
      [
        c.Id,
        c.CompanyName || `${c.GivenName || ''} ${c.FamilyName || ''}`.trim() || c.DisplayName,
        c.GivenName || null,
        c.FamilyName || null,
        c.PrimaryPhone?.FreeFormNumber || null,
        c.PrimaryEmailAddr?.Address || null,
        c.Active !== false,
      ]
    );
    count++;
  }
  return count;
}

module.exports = { syncFromQB };

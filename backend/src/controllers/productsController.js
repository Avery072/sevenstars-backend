const pool = require('../config/db');
const { createQBItem, updateQBItem } = require('../middleware/qbSync');

async function listProducts(req, res) {
  const result = await pool.query(
    'SELECT * FROM products WHERE active = TRUE ORDER BY category, description'
  );
  res.json(result.rows);
}

async function createProduct(req, res) {
  const { sku, description, category, unit, cost, price, show_price, reorder_point, vendor } = req.body;

  if (!sku || !description || !unit) {
    return res.status(400).json({ error: 'sku, description, and unit are required' });
  }

  const result = await pool.query(
    `INSERT INTO products (sku, description, category, unit, cost, price, show_price, reorder_point, vendor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [sku, description, category, unit, cost, price, show_price ?? true, reorder_point, vendor]
  );

  const product = result.rows[0];

  // Create in QB async — don't block the response
  createQBItem({
    Name: sku,
    Description: description,
    Type: 'Inventory',
    UnitPrice: price,
    IncomeAccountRef: { value: '1', name: 'Sales' },
    AssetAccountRef: { value: '2', name: 'Inventory Asset' },
    ExpenseAccountRef: { value: '3', name: 'Cost of Goods Sold' },
  })
    .then(async (qbItem) => {
      await pool.query('UPDATE products SET qb_item_id = $1 WHERE id = $2', [qbItem.Id, product.id]);
    })
    .catch((err) => console.error('QB item creation failed:', err.message));

  res.status(201).json(product);
}

async function updateProduct(req, res) {
  const { id } = req.params;
  const fields = req.body;

  const allowed = ['sku', 'description', 'category', 'unit', 'cost', 'price',
    'show_price', 'quantity_on_hand', 'reorder_point', 'vendor', 'active'];

  const sets = [];
  const values = [];
  let idx = 1;

  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = $${idx++}`);
      values.push(fields[key]);
    }
  }

  if (!sets.length) return res.status(400).json({ error: 'No valid fields to update' });

  sets.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE products SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
  res.json(result.rows[0]);
}

async function toggleShowPrice(req, res) {
  const { id } = req.params;

  const result = await pool.query(
    'UPDATE products SET show_price = NOT show_price, updated_at = NOW() WHERE id = $1 RETURNING *',
    [id]
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
  res.json(result.rows[0]);
}

async function deleteProduct(req, res) {
  const { id } = req.params;

  const result = await pool.query(
    'UPDATE products SET active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id',
    [id]
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
  res.json({ message: 'Product deactivated' });
}

module.exports = { listProducts, createProduct, updateProduct, toggleShowPrice, deleteProduct };

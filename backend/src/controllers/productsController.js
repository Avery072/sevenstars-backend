const pool = require('../config/db');
const { createQBItem, deleteQBItem, getQBAccounts } = require('../middleware/qbSync');
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function listProducts(req, res) {
  const result = await pool.query(
    'SELECT * FROM products WHERE active = TRUE ORDER BY category, description'
  );
  res.json(result.rows);
}

async function createProduct(req, res) {
  const {
    sku,
    description,
    category,
    unit,
    cost,
    price,
    show_price,
    reorder_point,
    vendor,
    quantity_on_hand,
    inv_start_date,
  } = req.body;

  if (!sku || !description || !unit) {
    return res.status(400).json({ error: 'sku, description, and unit are required' });
  }

  const result = await pool.query(
    `INSERT INTO products (sku, description, category, unit, cost, price, show_price, reorder_point, vendor, quantity_on_hand)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      sku,
      description,
      category,
      unit,
      cost,
      price,
      show_price ?? true,
      reorder_point,
      vendor,
      quantity_on_hand || 0,
    ]
  );

  try {
    const accounts = await getQBAccounts();
    const incomeAccount = accounts.find(a =>
      (a.Name || '').includes('Sales of Product Income') || a.AccountType === 'Income'
    );
    const assetAccount = accounts.find(a =>
      (a.Name || '').includes('Inventory Asset') || a.AccountSubType === 'Inventory'
    );
    const expenseAccount = accounts.find(a =>
      (a.Name || '').includes('Cost of Goods Sold') || a.AccountType === 'Cost of Goods Sold'
    );
    const incomeAccountRef = incomeAccount
      ? { value: incomeAccount.Id, name: incomeAccount.Name }
      : undefined;

    const inventoryPayload = {
      Name: sku,
      Description: description,
      Type: 'Inventory',
      UnitPrice: price || 0,
      PurchaseCost: cost || 0,
      QtyOnHand: quantity_on_hand || 0,
      InvStartDate: inv_start_date || new Date().toISOString().split('T')[0],
      IncomeAccountRef: incomeAccountRef,
      AssetAccountRef: assetAccount
        ? { value: assetAccount.Id, name: assetAccount.Name }
        : undefined,
      ExpenseAccountRef: expenseAccount
        ? { value: expenseAccount.Id, name: expenseAccount.Name }
        : undefined,
    };

    const qbItem = await createQBItem({
      ...inventoryPayload,
    });

    if (qbItem && qbItem.Id) {
      await pool.query('UPDATE products SET qb_item_id = $1 WHERE id = $2', [qbItem.Id, result.rows[0].id]);
      result.rows[0].qb_item_id = qbItem.Id;
    }
  } catch (inventoryErr) {
    const inventoryError = inventoryErr.response?.data ? JSON.stringify(inventoryErr.response.data) : inventoryErr.message;
    console.error('QB Inventory item creation failed, retrying as NonInventory:', inventoryError);

    try {
      const qbItem = await createQBItem({
        Name: sku,
        Description: description,
        Type: 'NonInventory',
        UnitPrice: price || 0,
      });

      if (qbItem && qbItem.Id) {
        await pool.query('UPDATE products SET qb_item_id = $1 WHERE id = $2', [qbItem.Id, result.rows[0].id]);
        result.rows[0].qb_item_id = qbItem.Id;
      }
    } catch (err) {
      const qbError = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error('QB item creation failed:', qbError);
      result.rows[0].qb_item_id = 'ERROR: ' + qbError;
      try {
        await pool.query(
          'UPDATE products SET qb_item_id = $1 WHERE id = $2',
          [result.rows[0].qb_item_id, result.rows[0].id]
        );
      } catch (dbErr) {
        console.error('Failed to store QB item creation error:', dbErr.message);
      }
    }
  }

  res.status(201).json(result.rows[0]);
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
    'UPDATE products SET active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id, qb_item_id',
    [id]
  );

  if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
  const product = result.rows[0];
  if (product.qb_item_id && !product.qb_item_id.startsWith('ERROR:')) {
    await deleteQBItem(product.qb_item_id);
  }
  res.json({ message: 'Product deactivated' });
}

async function uploadProductImage(req, res) {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'seven-stars-products', public_id: `product-${id}`, overwrite: true,
          transformation: [{ width: 800, height: 800, crop: 'limit' }] },
        (err, r) => { if (err) reject(err); else resolve(r); }
      ).end(req.file.buffer);
    });

    await pool.query('UPDATE products SET image_url = $1, updated_at = NOW() WHERE id = $2', [result.secure_url, id]);
    res.json({ image_url: result.secure_url });
  } catch (err) {
    console.error('Image upload failed:', err.message);
    res.status(500).json({ error: 'Image upload failed' });
  }
}

module.exports = { listProducts, createProduct, updateProduct, toggleShowPrice, deleteProduct, uploadProductImage };

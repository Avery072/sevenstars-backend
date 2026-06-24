const pool = require('../config/db');
const {
  createQBItem,
  deleteQBItem,
  getOrCreateQBItemCategory,
  getQBInventoryItemAccountRefs,
} = require('../middleware/qbSync');
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const PRODUCT_CATEGORIES = [
  'White Fish / Premium Fish',
  'Salmon',
  'Tuna',
  'Shrimp / Ebi',
  'Shellfish',
  'Crab / Imitation Crab',
  'Squid / Octopus',
  'Fish Roe / Specialty Seafood',
  'Eel / Unagi',
  'Seaweed / Sushi Wraps',
  'Frozen Appetizers / Prepared Foods',
  'Noodles / Ramen / Soup Base',
  'Tofu / Toppings / Garnish',
  'Vegetables / Pickles / Garnish',
  'Sauces / Seasonings / Condiments',
  'Dry Goods / Baking / Batter',
  'Meat / Non-seafood Protein',
  'Packaging / Consumption Supplies',
];

async function listProducts(req, res) {
  const result = await pool.query(
    'SELECT * FROM products WHERE active = TRUE ORDER BY category, description'
  );
  res.json(result.rows);
}

function formatQBError(err) {
  if (err.response?.data) {
    return JSON.stringify({
      status: err.response.status,
      data: err.response.data,
    });
  }
  return err.stack || err.message || String(err);
}

async function syncFallbackNonInventory(product, itemPayload, reason) {
  console.error('QB Inventory item creation failed, retrying as NonInventory:', reason);

  const qbItem = await createQBItem({
    Name: itemPayload.Name,
    Description: itemPayload.Description,
    Type: 'NonInventory',
    UnitPrice: itemPayload.UnitPrice,
    PurchaseCost: itemPayload.PurchaseCost,
    ParentRef: itemPayload.ParentRef,
    SubItem: itemPayload.SubItem,
    IncomeAccountRef: itemPayload.IncomeAccountRef,
    ExpenseAccountRef: itemPayload.ExpenseAccountRef,
  });

  if (qbItem && qbItem.Id) {
    await pool.query('UPDATE products SET qb_item_id = $1 WHERE id = $2', [qbItem.Id, product.id]);
    product.qb_item_id = qbItem.Id;
  }
}

async function storeQBItemError(product, error) {
  product.qb_item_id = `ERROR product ${product.id}: ${error}`;
  await pool.query('UPDATE products SET qb_item_id = $1 WHERE id = $2', [product.qb_item_id, product.id]);
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
  if (!PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Valid category is required' });
  }

  const existing = await pool.query(
    'SELECT id, sku, description FROM products WHERE LOWER(sku) = LOWER($1) OR LOWER(description) = LOWER($2)',
    [sku, description]
  );
  if (existing.rows.length > 0) {
    const dup = existing.rows[0];
    const field = dup.sku.toLowerCase() === sku.toLowerCase() ? `SKU "${dup.sku}"` : `description "${dup.description}"`;
    return res.status(409).json({ error: `A product with ${field} already exists` });
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

  const product = result.rows[0];
  const fallbackPayload = {
    Name: sku,
    Description: description,
    UnitPrice: price || 0,
    PurchaseCost: cost || 0,
  };
  let nonInventoryPayload = fallbackPayload;

  try {
    const qbCategory = await getOrCreateQBItemCategory(category);
    if (qbCategory && qbCategory.Id) {
      fallbackPayload.ParentRef = { value: qbCategory.Id, name: qbCategory.Name };
      fallbackPayload.SubItem = true;
    }

    let accountRefs;
    try {
      accountRefs = await getQBInventoryItemAccountRefs();
    } catch (accountErr) {
      const accountError = formatQBError(accountErr);
      try {
        await syncFallbackNonInventory(product, fallbackPayload, `QB account query failed: ${accountError}`);
      } catch (fallbackErr) {
        const qbError = formatQBError(fallbackErr);
        console.error('QB item creation failed:', qbError);
        try {
          await storeQBItemError(product, qbError);
        } catch (dbErr) {
          console.error('Failed to store QB item creation error:', dbErr.message);
        }
      }
      return res.status(201).json(product);
    }
    nonInventoryPayload = {
      ...fallbackPayload,
      IncomeAccountRef: accountRefs.IncomeAccountRef,
      ExpenseAccountRef: accountRefs.ExpenseAccountRef,
    };

    const inventoryPayload = {
      ...fallbackPayload,
      Type: 'Inventory',
      TrackQtyOnHand: true,
      QtyOnHand: quantity_on_hand || 0,
      InvStartDate: inv_start_date || new Date().toISOString().split('T')[0],
      ...accountRefs,
    };

    const qbItem = await createQBItem(inventoryPayload);

    if (qbItem && qbItem.Id) {
      await pool.query('UPDATE products SET qb_item_id = $1 WHERE id = $2', [qbItem.Id, product.id]);
      product.qb_item_id = qbItem.Id;
    }
  } catch (err) {
    const inventoryError = formatQBError(err);
    try {
      await syncFallbackNonInventory(product, nonInventoryPayload, inventoryError);
    } catch (fallbackErr) {
      const qbError = formatQBError(fallbackErr);
      console.error('QB item creation failed:', qbError);
      try {
        await storeQBItemError(product, qbError);
      } catch (dbErr) {
        console.error('Failed to store QB item creation error:', dbErr.message);
      }
    }
  }

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

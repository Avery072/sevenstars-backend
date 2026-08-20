const pool = require('../config/db');
const {
  createQBItem,
  deleteQBItem,
  getOrCreateQBItemCategory,
  getQBInventoryItemAccountRefs,
  setQBItemQuantity,
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
  // quantity_on_hand is exposed as available-to-sell (QB's synced count minus
  // what's already reserved by pending orders), not the raw QB number — kept
  // under the same field name so the mobile app's existing soldOut check
  // (which reads this field the same way) needs no changes.
  const result = await pool.query(
    `SELECT *, (quantity_on_hand - reserved) AS available
     FROM products WHERE active = TRUE ORDER BY category, description`
  );
  res.json(result.rows.map(({ available, ...p }) => ({ ...p, quantity_on_hand: available })));
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
    Sku: itemPayload.Sku,
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
    inv_start_date,
  } = req.body;

  if (!description || !unit) {
    return res.status(400).json({ error: 'description and unit are required' });
  }
  if (!PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Valid category is required' });
  }

  const productSku = sku || '';
  const existing = await pool.query(
    'SELECT id, sku, description FROM products WHERE LOWER(sku) = LOWER($1) OR LOWER(description) = LOWER($2)',
    [productSku, description]
  );
  if (existing.rows.length > 0) {
    const dup = existing.rows[0];
    const field = dup.sku.toLowerCase() === productSku.toLowerCase() ? `SKU "${dup.sku}"` : `description "${dup.description}"`;
    return res.status(409).json({ error: `A product with ${field} already exists` });
  }

  // quantity_on_hand starts at its column default (0) and is populated by the
  // QB Item webhook once the item exists in QB — the initial physical count
  // belongs in QB (e.g. via a PO or inventory adjustment), not typed here.
  const result = await pool.query(
    `INSERT INTO products (sku, description, category, unit, cost, price, show_price, reorder_point, vendor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      productSku,
      description,
      category,
      unit,
      cost,
      price,
      show_price ?? true,
      reorder_point,
      vendor,
    ]
  );

  const product = result.rows[0];
  const unitLabelMap = { each: 'each', lb: 'per lb', kg: 'per kg' };
  const unitLabel = unitLabelMap[unit] || unit;
  const fallbackPayload = {
    Name: description,
    Sku: sku || undefined,
    Description: `${description} ${unitLabel}`,
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
      QtyOnHand: 0,
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

  // quantity_on_hand is intentionally excluded: it's synced solely from QB
  // (Item webhook / sync) so it can't drift from QB's real inventory count —
  // see reservation/quantity split in ordersController.js.
  const allowed = ['sku', 'description', 'category', 'unit', 'cost', 'price',
    'show_price', 'reorder_point', 'vendor', 'active'];

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

// PATCH /api/products/:id/out-of-stock — sets QB's own quantity to 0
// synchronously (write-through, not local-then-push) so QB stays the actual
// ground truth for the number and a stray webhook can't silently revert it.
async function markOutOfStock(req, res) {
  const { id } = req.params;

  const productResult = await pool.query('SELECT qb_item_id FROM products WHERE id = $1', [id]);
  if (!productResult.rows.length) return res.status(404).json({ error: 'Product not found' });
  const { qb_item_id } = productResult.rows[0];
  if (!qb_item_id) return res.status(400).json({ error: 'Product has no linked QuickBooks item — run Sync from QB first' });

  await setQBItemQuantity(qb_item_id, 0);

  const result = await pool.query(
    'UPDATE products SET quantity_on_hand = 0, updated_at = NOW() WHERE id = $1 RETURNING *',
    [id]
  );
  res.json(result.rows[0]);
}

// PATCH /api/products/:id/available-override — { available_override: bool }.
// Purely local, never sent to or read from QuickBooks — see migration 016.
async function setAvailableOverride(req, res) {
  const { id } = req.params;
  const { available_override } = req.body;
  if (typeof available_override !== 'boolean') {
    return res.status(400).json({ error: 'available_override (boolean) is required' });
  }

  const result = await pool.query(
    'UPDATE products SET available_override = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [available_override, id]
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

module.exports = { listProducts, createProduct, updateProduct, toggleShowPrice, markOutOfStock, setAvailableOverride, deleteProduct, uploadProductImage };

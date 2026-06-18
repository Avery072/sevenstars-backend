-- Unique constraint on products.sku (deduplication enforcement at DB level)
-- Skip if duplicates exist — run: SELECT sku, COUNT(*) FROM products GROUP BY sku HAVING COUNT(*) > 1
-- to check first.
ALTER TABLE products ADD CONSTRAINT products_sku_unique UNIQUE (sku);

-- is_main flag on mobile_users: first account created for a company
-- is_main = true means this user is the primary contact / can approve new sub-accounts
ALTER TABLE mobile_users ADD COLUMN IF NOT EXISTS is_main BOOLEAN NOT NULL DEFAULT FALSE;

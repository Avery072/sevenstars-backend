ALTER TABLE orders
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN original_total NUMERIC(10,2);

UPDATE orders SET original_total = total WHERE original_total IS NULL;

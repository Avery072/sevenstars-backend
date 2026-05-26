-- Multiple orders can share the same QB invoice when merged by customer+date
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_qb_invoice_id_key;
CREATE INDEX IF NOT EXISTS idx_orders_qb_invoice_id ON orders(qb_invoice_id);

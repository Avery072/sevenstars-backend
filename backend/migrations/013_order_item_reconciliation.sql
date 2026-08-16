-- Line-level QB reconciliation for order_items: qb_line_id is the stable key
-- used to match a local line against a specific QB invoice Line when the
-- invoice is edited (qty/price changed, or a line added/removed) directly in
-- QuickBooks. status mirrors the existing orders.status pattern so a line QB
-- deletes is soft-removed (kept for audit trail) rather than hard-deleted.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS qb_line_id TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

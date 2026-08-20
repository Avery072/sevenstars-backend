-- Tracks where an order originated, set once at creation and never changed.
-- Drives edit permissions: mobile/admin orders are editable within our own
-- system (customer app or admin panel respectively); qb orders are entered
-- directly in QuickBooks by a salesperson and are never edited here.
-- Reconciliation (QB -> local) still applies to every order regardless of
-- source, though — fish is ordered by count through the app but the final
-- weight/price is only entered in QB after physical fulfillment, so a QB-side
-- correction on an in-system order is routine, not a conflict to guard against.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_source_check CHECK (source IN ('mobile', 'admin', 'qb'));

-- products.quantity_on_hand becomes the sole property of QB sync (Item
-- webhook / manual sync) — order placement no longer writes to it directly,
-- closing the lost-update race where a webhook's absolute QtyOnHand could
-- clobber a concurrent local decrement. Orders instead hold their claim on
-- stock in `reserved`, the app's own column: available-to-sell is
-- quantity_on_hand - reserved.
ALTER TABLE products ADD COLUMN IF NOT EXISTS reserved NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Tracks whether an order's reserved stock has been released back (cleared
-- once its QB invoice is confirmed, since QB's own quantity_on_hand has
-- already reflected the sale by then) — prevents double-releasing if a retry
-- path runs after a push already succeeded, and tells deleteOrder whether
-- there's still a reservation to release.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_released_at TIMESTAMPTZ;

-- Visibility into stuck QB pushes (replaces silently swallowing failures):
-- surfaced in the admin portal as a "stuck" badge distinct from plain pending.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS push_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_push_error TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_push_attempt_at TIMESTAMPTZ;

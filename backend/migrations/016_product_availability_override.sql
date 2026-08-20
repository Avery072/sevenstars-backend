-- Lets staff force a product to show as available regardless of the
-- QB-synced quantity_on_hand (e.g. the synced count is known to be stale and
-- staff don't know the exact real number, just that there is some stock).
-- Purely local — never sent to or read from QuickBooks. Cleared only by an
-- explicit staff action, never auto-clears when quantity syncs positive
-- again (confirmed deliberately — see order_editing_clarifications.md).
ALTER TABLE products ADD COLUMN IF NOT EXISTS available_override BOOLEAN NOT NULL DEFAULT FALSE;

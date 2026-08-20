-- Short-lived guard against reconciliation (webhook or periodic sweep)
-- interleaving with an in-flight edit push to the same invoice: set
-- immediately before pushOrderEditToQB calls QB, cleared immediately after
-- (success or failure). reconcileExistingOrder skips an order with this set
-- recently (see the staleness window in code) rather than risk pulling QB's
-- pre-push state and overwriting the edit that's about to land. A stale flag
-- from a crashed process self-heals after the window passes — no cleanup job
-- needed.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS qb_push_in_progress_at TIMESTAMPTZ;

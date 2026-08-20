-- Durable "still needs pushing to QB" marker for an already-invoiced line
-- whose quantity/price was changed locally — set by applyOrderEdit, cleared
-- once pushOrderEditToQB successfully patches it into QB. Exists so a retry
-- (after a failed push, possibly on a fresh process) knows exactly which
-- lines still need patching without re-diffing against QB's live state,
-- which would be ambiguous (a local/QB difference could mean "our change
-- hasn't landed yet" or "QB has a newer change we haven't pulled" — qb_dirty
-- records actual intent instead of guessing from a diff). A brand-new,
-- never-pushed line doesn't need this: qb_line_id IS NULL already marks it.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS qb_dirty BOOLEAN NOT NULL DEFAULT FALSE;

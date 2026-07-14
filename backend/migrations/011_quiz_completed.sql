-- Track whether a main user has completed the salmon-cut quiz.
-- Scoped per mobile_users row, which is already per-company — so a person who
-- is the main user of two companies (two rows) gets an independent flag for each.
ALTER TABLE mobile_users ADD COLUMN IF NOT EXISTS quiz_completed BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: any main user whose company already has a salmon preference set
-- (e.g. a company migrating in with preferences already configured) has
-- effectively completed the quiz and should not be re-prompted.
UPDATE mobile_users mu
SET quiz_completed = TRUE
FROM customers c
WHERE mu.customer_id = c.id
  AND mu.is_main = TRUE
  AND c.salmon_cut IS NOT NULL;

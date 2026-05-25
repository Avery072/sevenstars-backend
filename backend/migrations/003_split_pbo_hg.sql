-- Split combined pbo_hg column into separate pbo and hg boolean columns
ALTER TABLE customers ADD COLUMN pbo BOOLEAN DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN hg  BOOLEAN DEFAULT FALSE;

-- Migrate existing data: if pbo_hg was true, turn on both
UPDATE customers SET pbo = pbo_hg, hg = pbo_hg WHERE pbo_hg = TRUE;

ALTER TABLE customers DROP COLUMN pbo_hg;

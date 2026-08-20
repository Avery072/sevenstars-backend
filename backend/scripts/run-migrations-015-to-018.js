// Combined runner for the four migrations behind this session's work:
// origin-based order editing, availability override, and the two race-
// condition fixes (qb_push_in_progress_at, qb_dirty). All statements are
// ADD COLUMN IF NOT EXISTS / idempotent CHECK-constraint replace — safe to
// run more than once, and safe to run out of order relative to each other.
//
// Usage on Railway: `railway run node scripts/run-migrations-015-to-018.js`
// (or paste into a one-off Railway shell) — picks up DATABASE_URL from the
// environment, same as every other script in this folder.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log('015: orders.source, orders_source_check...');
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin';`);
  await pool.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_check;`);
  await pool.query(`ALTER TABLE orders ADD CONSTRAINT orders_source_check CHECK (source IN ('mobile', 'admin', 'qb'));`);

  console.log('016: products.available_override...');
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS available_override BOOLEAN NOT NULL DEFAULT FALSE;`);

  console.log('017: orders.qb_push_in_progress_at...');
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS qb_push_in_progress_at TIMESTAMPTZ;`);

  console.log('018: order_items.qb_dirty...');
  await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS qb_dirty BOOLEAN NOT NULL DEFAULT FALSE;`);

  console.log('Done — migrations 015 through 018 applied (or already were).');
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });

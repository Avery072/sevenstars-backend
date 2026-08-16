const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS qb_line_id TEXT;`);
  await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';`);
  console.log('Migration 013 done: qb_line_id and status columns added to order_items');
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS qb_push_in_progress_at TIMESTAMPTZ;`);
  console.log('Migration 017 done: qb_push_in_progress_at column added to orders');
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });

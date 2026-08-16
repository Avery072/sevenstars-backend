const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS reserved NUMERIC(10,2) NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_released_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS push_attempts INT NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_push_error TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_push_attempt_at TIMESTAMPTZ;`);
  console.log('Migration 014 done: reserved column added to products; reservation_released_at, push_attempts, last_push_error, last_push_attempt_at added to orders');
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });

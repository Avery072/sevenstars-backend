const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin';`);
  await pool.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_check;`);
  await pool.query(`ALTER TABLE orders ADD CONSTRAINT orders_source_check CHECK (source IN ('mobile', 'admin', 'qb'));`);
  console.log('Migration 015 done: source column added to orders');
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });

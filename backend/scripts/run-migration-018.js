const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS qb_dirty BOOLEAN NOT NULL DEFAULT FALSE;`);
  console.log('Migration 018 done: qb_dirty column added to order_items');
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });

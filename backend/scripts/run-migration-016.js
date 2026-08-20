const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS available_override BOOLEAN NOT NULL DEFAULT FALSE;`);
  console.log('Migration 016 done: available_override column added to products');
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });

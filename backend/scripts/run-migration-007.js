const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const sql = `ALTER TABLE customers ADD COLUMN IF NOT EXISTS buys_salmon BOOLEAN NOT NULL DEFAULT FALSE;`;
  await pool.query(sql);
  console.log('Migration 007 done: buys_salmon column added');
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });

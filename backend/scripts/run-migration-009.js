const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const sql = `ALTER TABLE orders ADD COLUMN IF NOT EXISTS qb_doc_number TEXT;`;
  await pool.query(sql);
  console.log('Migration 009 done: qb_doc_number column added to orders');
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });

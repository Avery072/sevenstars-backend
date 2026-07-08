const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// If more invoices were created in QBO after DocNumber 34789 (the highest
// confirmed real value as of 2026-07-08) before this runs, pass the correct
// starting value: START_AT=34795 node scripts/run-migration-010.js
const startAt = process.env.START_AT || '34790';

async function run() {
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS qb_invoice_doc_number_seq START WITH ${Number(startAt)}`);
  console.log(`Migration 010 done: qb_invoice_doc_number_seq created, starting at ${startAt}`);
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });

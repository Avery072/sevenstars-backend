/**
 * One-time import: reads "Salmon List Final (1).xlsx" and upserts
 * each customer's salmon cut preferences into the DB.
 *
 * Run from backend/ directory:
 *   node scripts/import-salmon-cuts.js
 *
 * Expected XLSX columns (row 1 = header):
 *   NAME | CUT | SKIN OFF | SCALE | PBO | H&G
 * An "X" in a cell means true; blank = false.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const xlsx = require('xlsx');
const { Pool } = require('pg');

const XLSX_PATH = path.join(__dirname, '../../../Salmon List Final (1).xlsx');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function isChecked(val) {
  if (val === null || val === undefined) return false;
  return String(val).trim().toUpperCase() === 'X';
}

async function run() {
  const wb = xlsx.readFile(XLSX_PATH);
  // CustomerList sheet: NAME | CUT | SKIN OFF | SCALE | PBO | H&G (row 0 = headers)
  const ws = wb.Sheets['CustomerList'];
  const raw = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
  // Skip header row; columns: 0=NAME 1=CUT 2=SKIN OFF 3=SCALE 4=PBO 5=H&G
  const rows = raw.slice(1);

  console.log(`Loaded ${rows.length} customer rows from CustomerList sheet\n`);

  let matched = 0;
  const unmatched = [];

  for (const row of rows) {
    const name = String(row[0] || '').trim();
    if (!name) continue;

    const cut       = String(row[1] || '').trim() || null;
    const skin_off  = isChecked(row[2]);
    const scale     = isChecked(row[3]);
    const pbo       = isChecked(row[4]);
    const hg        = isChecked(row[5]);

    // Match by company_name, case-insensitive
    const result = await pool.query(
      `UPDATE customers
       SET salmon_cut = $1, skin_off = $2, scale = $3, pbo = $4, hg = $5
       WHERE UPPER(TRIM(company_name)) = UPPER($6)
       RETURNING id, company_name`,
      [cut, skin_off, scale, pbo, hg, name]
    );

    if (result.rows.length) {
      matched++;
      const c = result.rows[0];
      const flags = [
        cut,
        skin_off  && 'Skin Off',
        scale     && 'Scale',
        pbo       && 'PBO',
        hg        && 'H&G',
      ].filter(Boolean).join(', ') || 'N/A';
      console.log(`  ✓  ${c.company_name.padEnd(45)} → ${flags}`);
    } else {
      unmatched.push(name);
      console.log(`  ✗  ${name}`);
    }
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Matched  : ${matched}`);
  console.log(`Unmatched: ${unmatched.length}`);
  if (unmatched.length) {
    console.log('\nUnmatched names (check spelling against DB):');
    unmatched.forEach(n => console.log(`  • ${n}`));
  }

  await pool.end();
}

run().catch(err => { console.error(err.message); process.exit(1); });

/**
 * One-time import: reads the master inventory CSV and upserts into products.
 * Run from backend/: node scripts/import-inventory.js
 *
 * CSV columns (double-comma = empty col):
 * 0:Frequent 1:Category 2:SKU _3 4:Description _5 6:Type _7
 * 8:Cost _9 10:Price _11 12:TaxCode _13 14:QtyOnHand _15
 * 16:QtyOnSO _17 18:ReorderPt _19 20:QtyOnPO _21
 * 22:UM _23 24:Vendor 25:DescWithMeasure _26 27:Keyword 28:Category
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const CSV_PATH = path.join(__dirname, '../../Item Lists with Frequent and Non-frequent.xlsm - ALL INVENTORY.csv');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Parse a single CSV line handling quoted fields
function parseLine(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      fields.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

// "13,116.79" or "-1,234.02" → number; negative → 0
function parseQty(raw) {
  const n = parseFloat((raw || '0').replace(/,/g, ''));
  return isNaN(n) || n < 0 ? 0 : n;
}

function parsePrice(raw) {
  const n = parseFloat((raw || '0').replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function mapUnit(raw) {
  const s = (raw || '').toLowerCase();
  if (s.includes('pound') || s.includes('lb'))   return 'lb';
  if (s.includes('case') || s.includes('ca'))    return 'CA';
  return 'ea';
}

async function run() {
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());

  let inserted = 0, updated = 0, skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);

    const sku         = (cols[2] || '').trim();
    const description = (cols[4] || '').trim();
    const category    = (cols[1] || '').trim();
    const unit        = mapUnit(cols[22]);
    const cost        = parsePrice(cols[8]);
    const price       = parsePrice(cols[10]);
    const qty         = parseQty(cols[14]);
    const reorder     = parseQty(cols[18]);
    const vendor      = (cols[24] || '').trim() || null;
    const showPrice   = price > 0;

    if (!sku || !description) { skipped++; continue; }

    const existing = await pool.query('SELECT id FROM products WHERE LOWER(sku) = LOWER($1)', [sku]);

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE products SET
           description=  $1, category=$2, unit=$3, cost=$4, price=$5,
           show_price=$6, quantity_on_hand=$7, reorder_point=$8,
           vendor=$9, active=true, updated_at=NOW()
         WHERE LOWER(sku) = LOWER($10)`,
        [description, category, unit, cost, price, showPrice, qty, reorder, vendor, sku]
      );
      updated++;
    } else {
      await pool.query(
        `INSERT INTO products
           (sku, description, category, unit, cost, price, show_price,
            quantity_on_hand, reorder_point, vendor, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
        [sku, description, category, unit, cost, price, showPrice, qty, reorder, vendor]
      );
      inserted++;
    }
  }

  console.log(`Done — ${inserted} inserted, ${updated} updated, ${skipped} skipped`);
  await pool.end();
}

run().catch(err => { console.error(err.message); process.exit(1); });

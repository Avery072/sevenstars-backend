/**
 * MERGE DUPLICATE CUSTOMERS — keeps the QuickBooks-linked copy, loses nothing.
 *
 * For every company name that exists more than once (case/whitespace-
 * insensitive), keeps the one copy that is linked to QuickBooks and folds the
 * other copies into it:
 *  - everything that references the duplicate (orders, mobile accounts, and
 *    any other table with a foreign key to customers) is moved to the kept
 *    copy — a plain DELETE would cascade-delete the mobile accounts instead;
 *  - local-only preferences (salmon cut, skin off, notes, address, ...) are
 *    copied onto the kept copy wherever it still has the default and a
 *    duplicate has a real value;
 *  - only then is the now-empty duplicate deleted.
 *
 * Run scripts/relink-to-qb.js first — it leaves exactly one linked copy per
 * name, which is what this script keys on. A name with no linked copy, or
 * with more than one (genuinely separate QuickBooks customers sharing a
 * name), is skipped and listed.
 *
 * (Replaces merge-duplicate-customers.js for this job: that one picks the
 * keeper by sort order and discards the duplicates' preferences.)
 *
 * Safety:
 *  - Without --yes it only prints what would happen.
 *  - Every deleted row is first copied in full to a table in Postgres
 *    (customers_merge_backup_*).
 *  - The whole merge runs in one transaction.
 *
 * Usage (run from backend/):
 *   node scripts/merge-duplicate-customers-safe.js          # preview
 *   node scripts/merge-duplicate-customers-safe.js --yes    # apply
 */

require('dotenv').config();
const pool = require('../src/config/db');

const CONFIRMED = process.argv.includes('--yes');

// Local-only field → column default. Same list as restore-customer-prefs.js.
const PREF_DEFAULTS = {
  address: null,
  language_pref: 'English',
  ordering_method: 'Mobile App',
  salmon_cut: null,
  buys_salmon: false,
  skin_off: false,
  scale: false,
  pbo: false,
  hg: false,
  notes: null,
  resale_certificate_number: null,
};

function key(s) {
  return (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isSet(field, value) {
  return value !== null && value !== undefined && value !== '' && value !== PREF_DEFAULTS[field];
}

async function main() {
  console.log('=== Seven Stars — Merge Duplicate Customers ===\n');

  // Every column anywhere that has a foreign key to customers.id — discovered
  // rather than hard-coded so a table added later can't be silently missed.
  const { rows: refs } = await pool.query(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'f' AND c.confrelid = 'customers'::regclass`
  );
  console.log(`Tables referencing customers: ${refs.map(r => `${r.tbl}.${r.col}`).join(', ')}\n`);

  const { rows: customers } = await pool.query('SELECT * FROM customers ORDER BY id');
  const prefFields = Object.keys(PREF_DEFAULTS).filter(f => customers.length && f in customers[0]);

  const groups = new Map();
  for (const c of customers) {
    const k = key(c.company_name);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }

  const merges = [];           // { keeper, dupes, prefs: { field: value } }
  const skippedNoLink = [];
  const skippedManyLinks = [];

  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const linked = rows.filter(r => r.qb_customer_id);
    if (linked.length === 0) { skippedNoLink.push(rows[0].company_name); continue; }
    if (linked.length > 1) { skippedManyLinks.push(rows[0].company_name); continue; }

    const keeper = linked[0];
    const dupes = rows.filter(r => r.id !== keeper.id);
    const prefs = {};
    for (const f of prefFields) {
      if (isSet(f, keeper[f])) continue;
      const donor = dupes.find(d => isSet(f, d[f])); // dupes are ordered by id — oldest wins
      if (donor) prefs[f] = donor[f];
    }
    merges.push({ keeper, dupes, prefs });
  }

  const dupeIds = merges.flatMap(m => m.dupes.map(d => d.id));
  const refCounts = {};
  for (const { tbl, col } of refs) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${tbl} WHERE ${col} = ANY($1)`, [dupeIds]);
    refCounts[`${tbl}.${col}`] = rows[0].n;
  }

  console.log(`Customers: ${customers.length}`);
  console.log(`Names to merge: ${merges.length}  (duplicate rows to remove: ${dupeIds.length})`);
  for (const [ref, n] of Object.entries(refCounts)) console.log(`  ${ref} rows to move to the kept copy: ${n}`);
  console.log(`  kept copies that receive preferences from a duplicate: ${merges.filter(m => Object.keys(m.prefs).length).length}`);
  console.log(`Customers after merge: ${customers.length - dupeIds.length}`);

  if (skippedNoLink.length) {
    console.log(`\nSkipped — no copy is linked to QuickBooks (${skippedNoLink.length}):`);
    for (const n of skippedNoLink) console.log(`  • ${n}`);
  }
  if (skippedManyLinks.length) {
    console.log(`\nSkipped — more than one copy is linked to QuickBooks, so they may be separate customers (${skippedManyLinks.length}):`);
    for (const n of skippedManyLinks) console.log(`  • ${n}`);
  }

  console.log('\nExamples:');
  for (const m of merges.slice(0, 5)) {
    const prefNote = Object.keys(m.prefs).length ? `, copying ${Object.keys(m.prefs).join(', ')}` : '';
    console.log(`  "${m.keeper.company_name}": keep id ${m.keeper.id} (QB ${m.keeper.qb_customer_id}), remove id ${m.dupes.map(d => d.id).join(', ')}${prefNote}`);
  }

  if (!merges.length) {
    console.log('\nNothing to merge.');
    await pool.end();
    return;
  }

  if (!CONFIRMED) {
    console.log('\nPreview only — nothing was written. Re-run with --yes to apply.');
    await pool.end();
    return;
  }

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`CREATE TABLE customers_merge_backup_${stamp} AS SELECT * FROM customers WHERE id = ANY($1)`, [dupeIds]);

    for (const { keeper, dupes, prefs } of merges) {
      const ids = dupes.map(d => d.id);
      for (const { tbl, col } of refs) {
        await db.query(`UPDATE ${tbl} SET ${col} = $1 WHERE ${col} = ANY($2)`, [keeper.id, ids]);
      }
      const fields = Object.keys(prefs);
      if (fields.length) {
        const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
        await db.query(`UPDATE customers SET ${sets} WHERE id = $${fields.length + 1}`, [...fields.map(f => prefs[f]), keeper.id]);
      }
      await db.query('DELETE FROM customers WHERE id = ANY($1)', [ids]);
    }

    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }

  console.log(`\n=== Done — merged ${merges.length} name(s), removed ${dupeIds.length} duplicate row(s) ===`);
  console.log(`Removed rows are saved in table customers_merge_backup_${stamp}.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('\nMerge failed (nothing was changed):', err.message);
  await pool.end();
  process.exit(1);
});

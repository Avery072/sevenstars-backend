/**
 * RESTORE CUSTOMER PREFERENCES — repair tool for a full-resync-from-qb.js run
 * that re-attached customer preferences by qb_customer_id against a different
 * QuickBooks company (where the same Id can be an unrelated business).
 *
 * Resets the local-only customer fields (the ones QuickBooks has no concept
 * of) to their column defaults on EVERY customer, then re-applies them from a
 * snapshot file, matched by company_name (case/whitespace-insensitive). A
 * name that appears more than once on either side is ambiguous and is skipped
 * rather than guessed at. Nothing else on customers is touched, and no other
 * table is touched at all.
 *
 * The snapshot can be either:
 *  - a backup written by full-resync-from-qb.js ({ customers: [...] }), or
 *  - a plain array of customer rows (data/customer-prefs-snapshot.json).
 *
 * Safety:
 *  - Without --yes it only prints what would change — nothing is written.
 *  - The reset + re-apply run in a single transaction: it all applies or
 *    none of it does.
 *  - The current values are written to scripts/backups/ before any change.
 *
 * Usage (run from backend/):
 *   node scripts/restore-customer-prefs.js                       # preview, default snapshot
 *   node scripts/restore-customer-prefs.js --yes                 # apply
 *   node scripts/restore-customer-prefs.js path/to/backup.json --yes
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');

const args = process.argv.slice(2);
const CONFIRMED = args.includes('--yes');
const SNAPSHOT_PATH = path.resolve(
  args.find(a => !a.startsWith('--')) || path.join(__dirname, '../data/customer-prefs-snapshot.json')
);

// Field → column default (see migrations). Same field list as
// LOCAL_ONLY_CUSTOMER_FIELDS in full-resync-from-qb.js.
const FIELD_DEFAULTS = {
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
const FIELDS = Object.keys(FIELD_DEFAULTS);

function nameKey(name) {
  return (name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function loadSnapshot() {
  const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed.customers;
  if (!Array.isArray(rows)) throw new Error(`No customers array found in ${SNAPSHOT_PATH}`);
  return rows;
}

// Keyed by normalized company_name; a name seen twice maps to null (ambiguous).
// A field missing from a snapshot row falls back to the column default.
function buildSnapshotMap(rows) {
  const map = new Map();
  for (const c of rows) {
    const key = nameKey(c.company_name);
    if (!key) continue;
    if (map.has(key)) { map.set(key, null); continue; }
    const fields = {};
    for (const f of FIELDS) fields[f] = c[f] !== undefined ? c[f] : FIELD_DEFAULTS[f];
    map.set(key, { name: c.company_name, fields });
  }
  return map;
}

function differs(row, target) {
  return FIELDS.some(f => (row[f] ?? null) !== (target[f] ?? null));
}

async function main() {
  console.log('=== Seven Stars — Restore Customer Preferences ===\n');
  console.log(`Snapshot: ${SNAPSHOT_PATH}`);

  const snapshotMap = buildSnapshotMap(loadSnapshot());
  const { rows: current } = await pool.query(
    `SELECT id, company_name, ${FIELDS.join(', ')} FROM customers ORDER BY id`
  );
  console.log(`Snapshot customers: ${snapshotMap.size}   Current customers: ${current.length}\n`);

  const currentNameCounts = new Map();
  for (const row of current) {
    const key = nameKey(row.company_name);
    currentNameCounts.set(key, (currentNameCounts.get(key) || 0) + 1);
  }

  const updates = [];        // { id, target } — only rows whose values actually change
  const ambiguous = [];
  const used = new Set();
  let restored = 0, cleared = 0;

  for (const row of current) {
    const key = nameKey(row.company_name);
    const snap = snapshotMap.get(key);
    let target = FIELD_DEFAULTS;

    if (snapshotMap.has(key)) {
      used.add(key);
      if (snap === null || currentNameCounts.get(key) > 1) ambiguous.push(row.company_name);
      else { target = snap.fields; restored++; }
    }

    if (target === FIELD_DEFAULTS && differs(row, FIELD_DEFAULTS)) cleared++;
    if (differs(row, target)) updates.push({ id: row.id, target });
  }

  const unmatched = [...snapshotMap.entries()]
    .filter(([key, v]) => v !== null && !used.has(key))
    .map(([, v]) => v.name);

  console.log(`Matched by company name (prefs restored from snapshot): ${restored}`);
  console.log(`Not in snapshot but currently holding non-default prefs (will be cleared): ${cleared}`);
  console.log(`Rows whose values actually change: ${updates.length} of ${current.length}`);
  if (ambiguous.length) {
    console.log(`\n${ambiguous.length} skipped — duplicate company name, reset to defaults, fix by hand:`);
    for (const name of ambiguous) console.log(`  - ${name}`);
  }
  if (unmatched.length) {
    console.log(`\n${unmatched.length} snapshot customer(s) have no customer with the same name now — prefs not restored:`);
    for (const name of unmatched) console.log(`  - ${name}`);
  }
  console.log();

  if (!CONFIRMED) {
    console.log('Preview only — nothing was written. Re-run with --yes to apply.');
    await pool.end();
    return;
  }

  const dir = path.join(__dirname, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const backupFile = path.join(dir, `customer-prefs-before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(current, null, 2));
  console.log(`Current values backed up: ${backupFile}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sets = FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ');
    for (const { id, target } of updates) {
      await client.query(
        `UPDATE customers SET ${sets} WHERE id = $${FIELDS.length + 1}`,
        [...FIELDS.map(f => target[f]), id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`\n=== Done — ${updates.length} customer(s) updated ===`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('\nRestore failed (nothing was changed):', err.message);
  await pool.end();
  process.exit(1);
});

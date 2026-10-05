/**
 * FULL RESYNC FROM QUICKBOOKS — destructive, one-shot cutover tool.
 *
 * Intended for the final QuickBooks data migration: wipes products, customers,
 * orders, order_items, and mobile_users, then rebuilds them from QuickBooks'
 * current state using the exact same sync code paths the app already runs
 * (upsertQBItem/upsertQBCustomer from services/qbEntitySync.js, and
 * runReconciliation from controllers/syncController.js for orders) — this
 * script does not reimplement QB-pull logic, it just calls it against empty
 * tables. admin_users and qb_tokens are never touched.
 *
 * Scope decisions (confirmed with the business before writing this):
 *  - mobile_users IS wiped (cascades automatically off customers anyway) —
 *    every customer will need to sign up again post-cutover.
 *  - customers has several fields QuickBooks has no concept of at all
 *    (salmon_cut, skin_off, scale, pbo, hg, buys_salmon, language_pref,
 *    ordering_method, resale_certificate_number, notes, address). These are
 *    backed up before the wipe and re-attached afterward, matched by
 *    company_name (case/whitespace-insensitive) — NOT by qb_customer_id:
 *    this script is run when cutting over to a different QuickBooks company,
 *    which assigns its own customer Ids, so an old Id and the same new Id
 *    can be two unrelated businesses. A name that appears more than once on
 *    either side is ambiguous and is skipped rather than guessed at; skipped
 *    and unmatched names are printed at the end for manual follow-up. A
 *    local customer that was never linked to QB (no qb_customer_id) is a
 *    test/local-only record and is deliberately left out (it still exists
 *    in the backup file).
 *  - orders/order_items are rebuilt from only the last LOOKBACK_DAYS..
 *    LOOKAHEAD_DAYS of QuickBooks invoice activity (TxnDate-based), not full
 *    history — this matches the app's own 31-day rolling purge policy, which
 *    would otherwise immediately re-delete anything older on the next purge
 *    cycle. The lookahead exists because an invoice's TxnDate is the order's
 *    delivery_date (see ordersController.pushToQBInner), so an
 *    already-placed but not-yet-delivered order can be dated in the near
 *    future — a pure look-back window would silently drop those.
 *  - A caveat inherited from the existing sync, not introduced here: QBO's
 *    plain `SELECT * FROM Customer` (used by upsertCustomers/upsertQBItem)
 *    only returns Active records, so an invoice referencing a customer who
 *    was later deactivated in QB won't find that customer pre-created and
 *    will fall back to fetching it individually (see processInvoice) — this
 *    already happens today and isn't new risk from this script.
 *
 * Safety:
 *  - Requires --yes on the command line, or it just prints what it would do.
 *  - Verifies QuickBooks is actually reachable BEFORE touching the database —
 *    refuses to wipe local data it then can't repopulate.
 *  - Always writes a timestamped JSON backup of every affected table before
 *    running any destructive statement.
 *  - --dry-run runs the backup + QB-connectivity check and prints exactly
 *    what would happen, without truncating or writing anything else.
 *
 * Usage (run from backend/):
 *   node scripts/full-resync-from-qb.js --yes
 *   node scripts/full-resync-from-qb.js --dry-run
 *   node scripts/full-resync-from-qb.js --yes --lookback-days=90 --lookahead-days=30
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db');
const { getValidAccessToken } = require('../src/config/quickbooks');
const { queryQBAll } = require('../src/middleware/qbSync');
const { upsertQBItem, upsertQBCustomer } = require('../src/services/qbEntitySync');
const { runReconciliation } = require('../src/controllers/syncController');

const args = process.argv.slice(2);
const CONFIRMED = args.includes('--yes');
const DRY_RUN = args.includes('--dry-run');
const LOOKBACK_DAYS = Number((args.find(a => a.startsWith('--lookback-days=')) || '').split('=')[1] || 60);
const LOOKAHEAD_DAYS = Number((args.find(a => a.startsWith('--lookahead-days=')) || '').split('=')[1] || 14);

// customers fields QuickBooks has no concept of — see header comment.
const LOCAL_ONLY_CUSTOMER_FIELDS = [
  'address', 'language_pref', 'ordering_method', 'salmon_cut', 'buys_salmon',
  'skin_off', 'scale', 'pbo', 'hg', 'notes', 'resale_certificate_number',
];

const WIPE_TABLES = ['order_items', 'orders', 'mobile_users', 'customers', 'products'];

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

async function backupTables() {
  const backup = {};
  for (const table of WIPE_TABLES) {
    const { rows } = await pool.query(`SELECT * FROM ${table}`);
    backup[table] = rows;
  }

  const dir = path.join(__dirname, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `full-resync-${isoStamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));

  return { file, backup };
}

function nameKey(name) {
  return (name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Keyed by normalized company_name — see header comment for why not
// qb_customer_id. A backed-up customer with no qb_customer_id (never linked
// to QB) is intentionally dropped, per the "only re-attach for matching
// customers" decision above. A name seen twice maps to null (ambiguous).
function buildPreservationMap(customersBackup) {
  const map = new Map();
  let skippedUnlinked = 0;
  for (const c of customersBackup) {
    if (!c.qb_customer_id) { skippedUnlinked++; continue; }
    const key = nameKey(c.company_name);
    if (!key) continue;
    if (map.has(key)) { map.set(key, null); continue; }
    const fields = {};
    for (const f of LOCAL_ONLY_CUSTOMER_FIELDS) fields[f] = c[f];
    map.set(key, { name: c.company_name, fields });
  }
  const ambiguous = [...map.values()].filter(v => v === null).length;
  return { map, skippedUnlinked, ambiguous };
}

async function reattachPreservedFields(map) {
  const { rows: freshCustomers } = await pool.query(
    'SELECT id, company_name FROM customers WHERE qb_customer_id IS NOT NULL'
  );

  const freshByName = new Map();
  for (const row of freshCustomers) {
    const key = nameKey(row.company_name);
    if (!freshByName.has(key)) freshByName.set(key, []);
    freshByName.get(key).push(row);
  }

  let matched = 0;
  const ambiguous = [];
  const used = new Set();
  for (const [key, rows] of freshByName) {
    if (!map.has(key)) continue;
    const preserved = map.get(key);
    used.add(key);
    if (preserved === null || rows.length > 1) { ambiguous.push(rows[0].company_name); continue; }

    const sets = LOCAL_ONLY_CUSTOMER_FIELDS.map((f, i) => `${f} = $${i + 1}`);
    const values = LOCAL_ONLY_CUSTOMER_FIELDS.map(f => preserved.fields[f]);
    values.push(rows[0].id);
    await pool.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
    matched++;
  }

  // Backed-up customers whose name doesn't exist in the new QB company at all.
  const unmatched = [...map.entries()]
    .filter(([key, v]) => v !== null && !used.has(key))
    .map(([, v]) => v.name);

  return { matched, totalFresh: freshCustomers.length, ambiguous, unmatched };
}

// Same loop shape as syncController.js's upsertItems/upsertCustomers — kept
// separate here only because those are wired to an Express (req, res) and
// this script has neither.
async function pullProductsAndCustomers() {
  const [items, customers] = await Promise.all([queryQBAll('Item'), queryQBAll('Customer')]);

  let itemsCreated = 0;
  for (const item of items) {
    if (item.Type === 'Category' || item.Type === 'Group') continue;
    const result = await upsertQBItem(item);
    if (result) itemsCreated++;
  }

  let customersCreated = 0;
  for (const c of customers) {
    const result = await upsertQBCustomer(c);
    if (result) customersCreated++;
  }

  return { itemsSeen: items.length, itemsCreated, customersSeen: customers.length, customersCreated };
}

async function main() {
  console.log('=== Seven Stars — Full Resync From QuickBooks ===\n');

  console.log('Checking QuickBooks connectivity...');
  const { realmId } = await getValidAccessToken(); // throws if no/invalid tokens — fail before touching the DB
  console.log(`QuickBooks reachable (realm ${realmId}).\n`);

  console.log('Backing up current data...');
  const { file: backupFile, backup } = await backupTables();
  console.log(`Backup written: ${backupFile}`);
  for (const table of WIPE_TABLES) console.log(`  ${table}: ${backup[table].length} row(s)`);
  console.log();

  const { map: preservationMap, skippedUnlinked, ambiguous: ambiguousBackup } = buildPreservationMap(backup.customers);
  console.log(`Preservable customer records (linked to a QB customer, matched by company name): ${preservationMap.size - ambiguousBackup}`);
  if (ambiguousBackup) console.log(`Duplicate company names in the backup (ambiguous, will not be reattached): ${ambiguousBackup}`);
  console.log(`Local-only/test customer records (no qb_customer_id, will not be reattached): ${skippedUnlinked}\n`);

  const from = addDays(new Date(), -LOOKBACK_DAYS);
  const to = addDays(new Date(), LOOKAHEAD_DAYS);
  console.log(`Orders will be rebuilt from QB invoices dated ${ymd(from)} to ${ymd(to)} (${LOOKBACK_DAYS}d back / ${LOOKAHEAD_DAYS}d ahead).\n`);

  if (DRY_RUN) {
    console.log('--dry-run: stopping here. No tables were wiped and nothing else was written.');
    await pool.end();
    return;
  }

  if (!CONFIRMED) {
    console.log('Refusing to proceed without --yes.');
    console.log(`This would TRUNCATE: ${WIPE_TABLES.join(', ')} — admin_users and qb_tokens are never touched.`);
    console.log('Re-run with --yes to actually execute, or --dry-run to preview without the confirmation gate.');
    await pool.end();
    return;
  }

  console.log(`Wiping: ${WIPE_TABLES.join(', ')} ...`);
  await pool.query(`TRUNCATE TABLE ${WIPE_TABLES.join(', ')} RESTART IDENTITY`);
  console.log('Wiped.\n');

  console.log('Pulling products and customers from QuickBooks...');
  const pullResult = await pullProductsAndCustomers();
  console.log(`  Items: ${pullResult.itemsSeen} seen, ${pullResult.itemsCreated} products created`);
  console.log(`  Customers: ${pullResult.customersSeen} seen, ${pullResult.customersCreated} customers created\n`);

  console.log('Re-attaching preserved customer preferences...');
  const reattach = await reattachPreservedFields(preservationMap);
  console.log(`  ${reattach.matched} of ${reattach.totalFresh} freshly-pulled customers matched a backed-up record by company name and were restored.`);
  if (reattach.ambiguous.length) {
    console.log(`  ${reattach.ambiguous.length} skipped — duplicate company name, fix by hand from the backup:`);
    for (const name of reattach.ambiguous) console.log(`    - ${name}`);
  }
  if (reattach.unmatched.length) {
    console.log(`  ${reattach.unmatched.length} backed-up customer(s) have no customer with the same name in QuickBooks — prefs not restored:`);
    for (const name of reattach.unmatched) console.log(`    - ${name}`);
  }
  console.log();

  console.log('Pulling recent orders (invoices) from QuickBooks...');
  const orderResult = await runReconciliation(ymd(from), ymd(to));
  if (orderResult.error) {
    console.error(`  Order pull failed: ${orderResult.error}`);
  } else {
    console.log(`  Checked ${orderResult.checked} invoice(s): ${orderResult.pulled} created, ${orderResult.updated} updated, ${orderResult.skipped} skipped.`);
  }

  console.log('\n=== Done ===');
  console.log(`Backup for this run: ${backupFile}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('\nFull resync failed:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
  console.error('If this failed after the wipe step, restore from the backup file printed above.');
  await pool.end();
  process.exit(1);
});

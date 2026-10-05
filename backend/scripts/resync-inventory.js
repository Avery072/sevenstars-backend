/**
 * RESYNC INVENTORY FROM QUICKBOOKS — non-destructive.
 *
 * Re-reads every active QuickBooks Item and upserts it into products using
 * the same code path as the Item webhook and the admin "Sync from QB" button
 * (upsertQBItem from services/qbEntitySync.js) — so quantity_on_hand, price,
 * cost, description, unit and category follow QuickBooks, and nothing is
 * deleted. Local-only fields (show_price, available_override, reserved,
 * reorder_point, vendor, image_url) are never touched. Customers and orders
 * are not touched at all.
 *
 * quantity_on_hand is only taken from QuickBooks for Inventory-type items —
 * Service/NonInventory items carry no quantity there, so theirs is left as is.
 *
 * Usage (run from backend/):
 *   node scripts/resync-inventory.js
 */

require('dotenv').config();
const pool = require('../src/config/db');
const { getValidAccessToken } = require('../src/config/quickbooks');
const { queryQBAll } = require('../src/middleware/qbSync');
const { upsertQBItem } = require('../src/services/qbEntitySync');

async function main() {
  console.log('=== Seven Stars — Resync Inventory From QuickBooks ===\n');

  const { realmId } = await getValidAccessToken();
  console.log(`QuickBooks reachable (realm ${realmId}).`);

  const items = await queryQBAll('Item');
  console.log(`Pulled ${items.length} item(s) from QuickBooks.\n`);

  let created = 0, updated = 0, unchanged = 0, skipped = 0, quantityChanges = 0;
  const seenQbIds = [];

  for (const item of items) {
    if (item.Type === 'Category' || item.Type === 'Group') { skipped++; continue; }
    seenQbIds.push(String(item.Id));

    const result = await upsertQBItem(item);
    if (!result) { unchanged++; continue; }

    if (result.status === 'created') {
      created++;
      console.log(`  + ${result.sku} (new)`);
      continue;
    }

    updated++;
    const qty = result.changes.quantity_on_hand;
    if (qty) {
      quantityChanges++;
      console.log(`  ~ ${result.sku}: quantity_on_hand ${qty.from} -> ${qty.to}`);
    } else {
      console.log(`  ~ ${result.sku}: ${Object.keys(result.changes).join(', ')}`);
    }
  }

  // Active local products QuickBooks didn't return — never linked, or
  // deactivated/deleted there. Reported only; nothing is changed for them.
  const { rows: notInQB } = await pool.query(
    `SELECT sku FROM products
     WHERE active AND (qb_item_id IS NULL OR NOT (qb_item_id = ANY($1::text[])))
     ORDER BY sku`,
    [seenQbIds]
  );

  console.log('\n─────────────────────────────────────────');
  console.log(`Created   : ${created}`);
  console.log(`Updated   : ${updated} (${quantityChanges} with a quantity change)`);
  console.log(`Unchanged : ${unchanged}`);
  console.log(`Skipped   : ${skipped} (QuickBooks categories/groups)`);
  if (notInQB.length) {
    console.log(`\n${notInQB.length} active local product(s) not returned by QuickBooks (left untouched):`);
    for (const p of notInQB) console.log(`  • ${p.sku}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('\nInventory resync failed:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
  await pool.end();
  process.exit(1);
});

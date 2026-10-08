/**
 * RELINK TO QUICKBOOKS — non-destructive repair for when the app is connected
 * to a different QuickBooks company than the one its products/customers were
 * synced from (same SKUs and customer names, different QuickBooks Ids).
 *
 * Symptoms this fixes: "new line references unknown item N — skipping" on
 * invoices pulled from QB, and "Invalid Reference Id ... ItemRef" when
 * pushing orders to QB.
 *
 * What it does:
 *  1. Re-points products.qb_item_id at the connected company's items, matched
 *     by SKU (QB item Name, case-insensitive).
 *  2. Re-points customers.qb_customer_id, matched by company name
 *     (case/whitespace-insensitive, same name rule as the normal QB sync).
 *  3. Runs the normal item/customer upsert so quantities/prices follow QB and
 *     anything QB has that the app doesn't is added.
 *  4. Raises the invoice-number counter past the highest recent DocNumber in
 *     this company (never lowers it).
 *
 * Nothing is deleted. Orders, order lines, mobile users, and every local-only
 * field (show_price, available_override, image_url, salmon prefs, ...) are
 * left alone. A product/customer with no match in QuickBooks ends up
 * unlinked (its old Id means nothing in this company) and is listed.
 * Where the same customer exists more than once locally, exactly one copy is
 * linked (the one the QB sync already created for this company, if any) and
 * the others are unlinked — duplicates are NOT merged or deleted here.
 *
 * Safety:
 *  - Without --yes it only prints what would change.
 *  - The old links are copied to tables in Postgres (products_qb_link_backup_*,
 *    customers_qb_link_backup_*) before anything is changed.
 *  - The relink itself runs in one transaction.
 *  - A link that is already correct for this company is never removed.
 *  - If the existing links already line up with this company it refuses to
 *    run (nothing to repair) unless --force is given.
 *
 * Usage (run from backend/):
 *   node scripts/relink-to-qb.js          # preview
 *   node scripts/relink-to-qb.js --yes    # apply
 */

require('dotenv').config();
const pool = require('../src/config/db');
const { getValidAccessToken } = require('../src/config/quickbooks');
const { getQBClient, queryQBAll } = require('../src/middleware/qbSync');
const { upsertQBItem, upsertQBCustomer } = require('../src/services/qbEntitySync');

const args = process.argv.slice(2);
const CONFIRMED = args.includes('--yes');
const FORCE = args.includes('--force');

function key(s) {
  return (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Same name rule as upsertQBCustomer.
function qbCustomerName(c) {
  return c.CompanyName || `${c.GivenName || ''} ${c.FamilyName || ''}`.trim() || c.DisplayName;
}

// Groups rows by key; a key with more than one row is ambiguous.
function groupBy(rows, keyOf) {
  const map = new Map();
  for (const row of rows) {
    const k = keyOf(row);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

// Returns { links: [{ localId, qbId }], duplicates: [label], ambiguous: [label],
//           localUnmatched: [label], qbUnmatched: [key], alreadyCorrect: n }
//
// Every local row NOT in `links` ends up unlinked. Rules per name/SKU:
//  - one local row, one QB record        -> link them.
//  - several local rows, one QB record   -> (duplicates) link exactly one: the
//    row already pointing at that QB Id if there is one (it is the copy the
//    QB sync created for this company), otherwise the oldest row. The other
//    copies are unlinked — their Id belongs to another company. Nothing is
//    merged or deleted here.
//  - several QB records with that name   -> (ambiguous) can't tell which is
//    which: rows already pointing at one of those Ids keep their link, the
//    rest are unlinked.
function planRelink(localRows, qbRows, { localKey, qbKey, localLink, label }) {
  const localByKey = groupBy(localRows, localKey);
  const qbByKey = groupBy(qbRows, qbKey);

  const links = [];
  const duplicates = [];
  const ambiguous = [];
  const localUnmatched = [];
  let alreadyCorrect = 0;

  for (const [k, locals] of localByKey) {
    const qbs = qbByKey.get(k);
    if (!qbs) {
      for (const l of locals) if (localLink(l)) localUnmatched.push(label(l));
      continue;
    }

    if (qbs.length > 1) {
      ambiguous.push(label(locals[0]));
      const qbIds = new Set(qbs.map(q => String(q.Id)));
      const claimed = new Set();
      for (const l of locals) {
        const current = String(localLink(l) || '');
        if (qbIds.has(current) && !claimed.has(current)) {
          claimed.add(current);
          links.push({ localId: l.id, qbId: current });
          alreadyCorrect++;
        }
      }
      continue;
    }

    const qbId = String(qbs[0].Id);
    const correct = locals.find(l => String(localLink(l) || '') === qbId);
    if (correct) alreadyCorrect++;
    if (locals.length > 1) duplicates.push(label(locals[0]));
    links.push({ localId: (correct || locals[0]).id, qbId }); // locals are ordered by id — [0] is the oldest
  }

  const qbUnmatched = [...qbByKey.keys()].filter(k => !localByKey.has(k));
  return { links, duplicates, ambiguous, localUnmatched, qbUnmatched, alreadyCorrect };
}

function printList(title, list, max = 40) {
  if (!list.length) return;
  console.log(`\n${title} (${list.length}):`);
  for (const name of list.slice(0, max)) console.log(`  • ${name}`);
  if (list.length > max) console.log(`  … and ${list.length - max} more`);
}

async function highestRecentDocNumber() {
  const client = await getQBClient();
  const query = 'SELECT Id, DocNumber FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 200';
  const { data } = await client.get(`/query?query=${encodeURIComponent(query)}&minorversion=65`);
  const numbers = (data?.QueryResponse?.Invoice || [])
    .map(inv => inv.DocNumber)
    .filter(n => /^\d+$/.test(n || ''))
    .map(Number);
  return numbers.length ? Math.max(...numbers) : null;
}

async function main() {
  console.log('=== Seven Stars — Relink Products & Customers To QuickBooks ===\n');

  const { realmId } = await getValidAccessToken();
  const client = await getQBClient();
  const { data: ci } = await client.get(`/query?query=${encodeURIComponent('SELECT * FROM CompanyInfo')}&minorversion=65`);
  console.log(`Connected QuickBooks company: ${ci?.QueryResponse?.CompanyInfo?.[0]?.CompanyName} (realm ${realmId})\n`);

  const [allItems, qbCustomers] = await Promise.all([queryQBAll('Item'), queryQBAll('Customer')]);
  const qbItems = allItems.filter(i => i.Type !== 'Category' && i.Type !== 'Group');

  const { rows: products } = await pool.query('SELECT id, sku, qb_item_id FROM products ORDER BY id');
  const { rows: customers } = await pool.query('SELECT id, company_name, qb_customer_id FROM customers ORDER BY id');

  const productPlan = planRelink(products, qbItems, {
    localKey: p => key(p.sku), qbKey: i => key(i.Name), localLink: p => p.qb_item_id, label: p => p.sku,
  });
  const customerPlan = planRelink(customers, qbCustomers, {
    localKey: c => key(c.company_name), qbKey: c => key(qbCustomerName(c)), localLink: c => c.qb_customer_id, label: c => c.company_name,
  });

  console.log(`PRODUCTS   QuickBooks items: ${qbItems.length}   local products: ${products.length}`);
  console.log(`  matched by SKU: ${productPlan.links.length}  (already pointing at the right Id: ${productPlan.alreadyCorrect})`);
  console.log(`  local products that lose their link (SKU not in this company): ${productPlan.localUnmatched.length}`);
  console.log(`  QuickBooks items with no local product (will be added): ${productPlan.qbUnmatched.length}`);
  console.log(`  SKU on more than one local product (one copy linked, the rest unlinked): ${productPlan.duplicates.length}`);
  console.log(`  SKU on more than one QuickBooks item (ambiguous, existing correct links kept): ${productPlan.ambiguous.length}`);

  console.log(`\nCUSTOMERS  QuickBooks customers: ${qbCustomers.length}   local customers: ${customers.length}`);
  console.log(`  matched by name: ${customerPlan.links.length}  (already pointing at the right Id: ${customerPlan.alreadyCorrect})`);
  console.log(`  local customers that lose their link (name not in this company): ${customerPlan.localUnmatched.length}`);
  console.log(`  QuickBooks customers with no local customer (will be added): ${customerPlan.qbUnmatched.length}`);
  console.log(`  name on more than one local customer (one copy linked, the rest unlinked): ${customerPlan.duplicates.length}`);
  console.log(`  name on more than one QuickBooks customer (ambiguous, existing correct links kept): ${customerPlan.ambiguous.length}`);

  printList('Products losing their QuickBooks link', productPlan.localUnmatched);
  printList('Products with a duplicated SKU', productPlan.duplicates);
  printList('Products with an ambiguous SKU', productPlan.ambiguous);
  printList('Customers losing their QuickBooks link', customerPlan.localUnmatched);
  printList('Customers that exist more than once locally (not merged here)', customerPlan.duplicates, 15);
  printList('Customers with an ambiguous name', customerPlan.ambiguous);

  // Best-effort — a failed lookup must not block the relink itself.
  const maxDoc = await highestRecentDocNumber().catch(err => {
    console.warn(`\nCould not read recent invoice numbers from QuickBooks (${err.message}) — counter will be left as is.`);
    return null;
  });
  const { rows: [seq] } = await pool.query('SELECT last_value FROM qb_invoice_doc_number_seq');
  console.log(`\nINVOICE NUMBERS  highest recent in QuickBooks: ${maxDoc ?? 'none found'}   app counter: ${seq.last_value}`);

  const linkedBefore = products.filter(p => p.qb_item_id).length;
  if (!FORCE && linkedBefore && productPlan.alreadyCorrect / linkedBefore > 0.9) {
    console.log('\nThe existing product links already match this company — nothing to repair. (Use --force to run anyway.)');
    await pool.end();
    return;
  }

  if (!CONFIRMED) {
    console.log('\nPreview only — nothing was written. Re-run with --yes to apply.');
    await pool.end();
    return;
  }

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  await pool.query(`CREATE TABLE products_qb_link_backup_${stamp} AS SELECT id, sku, qb_item_id FROM products`);
  await pool.query(`CREATE TABLE customers_qb_link_backup_${stamp} AS SELECT id, company_name, qb_customer_id FROM customers`);
  console.log(`\nOld links saved to tables products_qb_link_backup_${stamp} and customers_qb_link_backup_${stamp}.`);

  // Clear every link first — the old Ids belong to another company, and the
  // UNIQUE constraints would otherwise collide while Ids are being reassigned.
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('UPDATE products SET qb_item_id = NULL WHERE qb_item_id IS NOT NULL');
    for (const { localId, qbId } of productPlan.links) {
      await db.query('UPDATE products SET qb_item_id = $1 WHERE id = $2', [qbId, localId]);
    }
    await db.query('UPDATE customers SET qb_customer_id = NULL WHERE qb_customer_id IS NOT NULL');
    for (const { localId, qbId } of customerPlan.links) {
      await db.query('UPDATE customers SET qb_customer_id = $1 WHERE id = $2', [qbId, localId]);
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
  console.log(`Relinked ${productPlan.links.length} product(s) and ${customerPlan.links.length} customer(s).`);

  let itemsCreated = 0, itemsUpdated = 0, customersCreated = 0, customersUpdated = 0;
  const failures = [];

  for (const item of qbItems) {
    try {
      const r = await upsertQBItem(item);
      if (r?.status === 'created') itemsCreated++; else if (r) itemsUpdated++;
    } catch (err) {
      failures.push(`item "${item.Name}": ${err.message}`);
    }
  }
  for (const c of qbCustomers) {
    try {
      const r = await upsertQBCustomer(c);
      if (r?.status === 'created') customersCreated++; else if (r) customersUpdated++;
    } catch (err) {
      failures.push(`customer "${qbCustomerName(c)}": ${err.message}`);
    }
  }
  console.log(`Synced from QuickBooks — products: ${itemsCreated} added, ${itemsUpdated} updated; customers: ${customersCreated} added, ${customersUpdated} updated.`);
  printList('Failed to sync', failures);

  if (maxDoc !== null && maxDoc > Number(seq.last_value)) {
    await pool.query("SELECT setval('qb_invoice_doc_number_seq', $1)", [maxDoc]);
    console.log(`Invoice-number counter raised to ${maxDoc} (next invoice: ${maxDoc + 1}).`);
  } else {
    console.log('Invoice-number counter left as is.');
  }

  console.log('\n=== Done ===');
  console.log('Pending orders will be pushed, and lines skipped on recent QuickBooks invoices filled in, on the next 20-minute sweep.');
  await pool.end();
}

main().catch(async (err) => {
  console.error('\nRelink failed:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
  await pool.end();
  process.exit(1);
});

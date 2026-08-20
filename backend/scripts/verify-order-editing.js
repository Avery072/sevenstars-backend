// Read-only verification for this session's work — schema presence, the
// edit-cutoff SQL formula, and a few health checks over existing data.
// Does NOT create/edit/delete any order, product, or QB object — safe to
// run against production. Run after run-migrations-015-to-018.js.
//
// Usage on Railway: `railway run node scripts/verify-order-editing.js`
// Optionally set BACKEND_URL to also hit the live public products endpoint
// (defaults to the production URL below — override or unset PING_URL's
// value if you don't want the network check).
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const PING_URL = process.env.BACKEND_URL || 'https://sevenstars-backend-production.up.railway.app';

let failures = 0;
function pass(label) { console.log(`  OK   ${label}`); }
function fail(label, detail) { failures++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }

async function checkColumns() {
  console.log('\n1. Schema — new columns exist with the right types/defaults');
  const { rows } = await pool.query(`
    SELECT table_name, column_name, data_type, column_default
    FROM information_schema.columns
    WHERE (table_name = 'orders' AND column_name IN ('source', 'qb_push_in_progress_at'))
       OR (table_name = 'products' AND column_name = 'available_override')
       OR (table_name = 'order_items' AND column_name = 'qb_dirty')
  `);
  const found = new Map(rows.map(r => [`${r.table_name}.${r.column_name}`, r]));

  const expected = [
    ['orders.source', 'text'],
    ['orders.qb_push_in_progress_at', 'timestamp with time zone'],
    ['products.available_override', 'boolean'],
    ['order_items.qb_dirty', 'boolean'],
  ];
  for (const [key, type] of expected) {
    const row = found.get(key);
    if (!row) { fail(key, 'column missing — did the migration run?'); continue; }
    if (row.data_type !== type) { fail(key, `expected type ${type}, got ${row.data_type}`); continue; }
    pass(key);
  }

  const { rows: constraintRows } = await pool.query(`
    SELECT conname FROM pg_constraint WHERE conname = 'orders_source_check'
  `);
  if (constraintRows.length) pass('orders_source_check constraint exists');
  else fail('orders_source_check constraint', 'missing');
}

async function checkCutoffFormula() {
  console.log("\n2. Edit-cutoff SQL — 2am Pacific on the delivery date itself");
  const { rows } = await pool.query(`
    SELECT
      ((DATE '2026-08-20'::timestamp + INTERVAL '2 hours') AT TIME ZONE 'America/Los_Angeles') AS cutoff_utc
  `);
  const cutoff = rows[0].cutoff_utc;
  // 2026-08-20 02:00 PDT (UTC-7) = 2026-08-20T09:00:00Z
  const expected = new Date('2026-08-20T09:00:00.000Z').getTime();
  if (cutoff.getTime() === expected) pass('2026-08-20 -> cutoff is 2026-08-20T09:00:00Z (2am PDT)');
  else fail('cutoff formula', `got ${cutoff.toISOString()}, expected 2026-08-20T09:00:00.000Z`);
}

async function checkHealthOfExistingData() {
  console.log('\n3. Data health (informational — not necessarily failures)');

  const { rows: sourceCounts } = await pool.query(`SELECT source, COUNT(*) FROM orders GROUP BY source ORDER BY source`);
  console.log('  Orders by source:', sourceCounts.map(r => `${r.source}=${r.count}`).join(', ') || '(no orders)');

  const { rows: stuckPush } = await pool.query(`
    SELECT id FROM orders
    WHERE qb_push_in_progress_at IS NOT NULL AND qb_push_in_progress_at < NOW() - INTERVAL '10 minutes'
  `);
  if (stuckPush.length) {
    fail('stuck qb_push_in_progress_at', `order(s) ${stuckPush.map(r => r.id).join(', ')} — flag stuck >10min, likely a crashed process; safe to manually clear (UPDATE orders SET qb_push_in_progress_at = NULL WHERE id = ...)`);
  } else {
    pass('no orders stuck mid-push');
  }

  const { rows: dirtyOld } = await pool.query(`
    SELECT oi.order_id, COUNT(*) FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.qb_dirty = TRUE AND o.qb_invoice_id IS NOT NULL AND oi.id IN (
      SELECT id FROM order_items WHERE qb_dirty = TRUE
    )
    GROUP BY oi.order_id
  `);
  if (dirtyOld.length) {
    console.log(`  NOTE  ${dirtyOld.length} order(s) have qb_dirty lines pending push — normal if recent, worth checking last_push_error if old: ${dirtyOld.map(r => r.order_id).join(', ')}`);
  } else {
    pass('no order_items pending a QB push');
  }

  const { rows: pushFailed } = await pool.query(`
    SELECT id, push_attempts, last_push_error FROM orders WHERE qb_invoice_id IS NOT NULL AND push_attempts > 0
  `);
  if (pushFailed.length) {
    console.log(`  NOTE  ${pushFailed.length} order(s) show a past push failure (push_attempts > 0) — the reconciliation job retries these automatically every ~20min; check last_push_error if one persists:`);
    pushFailed.forEach(r => console.log(`        order ${r.id}: ${r.push_attempts} attempt(s) — ${(r.last_push_error || '').slice(0, 120)}`));
  } else {
    pass('no orders with a recorded push failure');
  }
}

async function checkPublicEndpoint() {
  console.log(`\n4. Live public endpoint — GET ${PING_URL}/api/mobile/products (no auth, read-only)`);
  try {
    const res = await fetch(`${PING_URL}/api/mobile/products`);
    if (!res.ok) { fail('products endpoint', `HTTP ${res.status}`); return; }
    const data = await res.json();
    if (Array.isArray(data)) pass(`products endpoint responded with ${data.length} product(s)`);
    else fail('products endpoint', 'response was not an array — unexpected shape');
  } catch (err) {
    fail('products endpoint', err.message);
  }
}

async function run() {
  await checkColumns();
  await checkCutoffFormula();
  await checkHealthOfExistingData();
  await checkPublicEndpoint();

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed — see FAIL lines above.`}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });

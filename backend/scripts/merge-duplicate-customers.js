/**
 * Finds duplicate customers (same company_name), keeps the one with a
 * qb_customer_id (or the lowest id if none have one), reassigns all orders
 * and mobile_users to the keeper, then deletes the dupes.
 *
 * Run from backend/:  node scripts/merge-duplicate-customers.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/seven_stars_food' });

async function run() {
  const { rows: groups } = await pool.query(`
    SELECT company_name, array_agg(id ORDER BY qb_customer_id NULLS LAST, id) AS ids,
           array_agg(qb_customer_id ORDER BY qb_customer_id NULLS LAST, id) AS qb_ids
    FROM customers
    GROUP BY company_name
    HAVING COUNT(*) > 1
    ORDER BY company_name
  `);

  if (!groups.length) {
    console.log('No duplicates found.');
    await pool.end(); return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const group of groups) {
      const keepId = group.ids[0];       // first = has qb_id or lowest id
      const dupeIds = group.ids.slice(1);

      console.log(`\n"${group.company_name}"`);
      console.log(`  Keep   : id=${keepId}`);
      console.log(`  Delete : ids=${dupeIds.join(', ')}`);

      // Reassign orders
      const orders = await client.query(
        `UPDATE orders SET customer_id = $1 WHERE customer_id = ANY($2) RETURNING id`,
        [keepId, dupeIds]
      );
      if (orders.rowCount) console.log(`  Reassigned ${orders.rowCount} order(s)`);

      // Reassign mobile_users
      const users = await client.query(
        `UPDATE mobile_users SET customer_id = $1 WHERE customer_id = ANY($2) RETURNING id`,
        [keepId, dupeIds]
      );
      if (users.rowCount) console.log(`  Reassigned ${users.rowCount} mobile user(s)`);

      // Delete dupes
      await client.query(`DELETE FROM customers WHERE id = ANY($1)`, [dupeIds]);
      console.log(`  Deleted ${dupeIds.length} duplicate row(s)`);
    }

    await client.query('COMMIT');
    console.log('\nDone.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error — rolled back:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

run();

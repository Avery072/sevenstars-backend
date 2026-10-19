/**
 * RELINK PRODUCT IMAGES — re-attach Cloudinary images to products after
 * full-resync-from-qb.js reset products.id (TRUNCATE ... RESTART IDENTITY)
 * and dropped image_url.
 *
 * Images were uploaded as seven-stars-products/product-<old id>. The old
 * id → sku mapping comes from a products_qb_link_backup_* table written by
 * relink-to-qb.js; each image is then attached to whichever product has that
 * sku now.
 *
 * Per Cloudinary asset product-<n>:
 *  - Already some product's image_url → uploaded since the resync, under the
 *    new id, and already linked. Skipped. If the backup says old id n was a
 *    different sku, that old product's image was overwritten and is gone —
 *    listed for re-upload.
 *  - Otherwise old id n → sku (backup table) → current product by sku
 *    (case/whitespace-insensitive), and image_url is set. A product that
 *    already has an image_url is left alone unless --force.
 *
 * Refuses to run if the backup table looks like it was taken AFTER the
 * resync (most skus have the same id in it as they do now) — its ids would
 * then be the new ones and every link would be wrong. --force overrides.
 *
 * Safety:
 *  - Without --yes it only prints what would change — nothing is written.
 *  - All updates run in a single transaction; only products.image_url is touched.
 *
 * Usage (run from backend/):
 *   node scripts/relink-product-images.js products_qb_link_backup_20261008001527
 *   node scripts/relink-product-images.js products_qb_link_backup_20261008001527 --yes
 */

require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const pool = require('../src/config/db');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const args = process.argv.slice(2);
const CONFIRMED = args.includes('--yes');
const FORCE = args.includes('--force');
const BACKUP_TABLE = args.find(a => !a.startsWith('--'));
const PREFIX = 'seven-stars-products/product-';

function skuKey(sku) {
  return (sku || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// .../upload/[<transforms>/]v<version>/<public_id>.<ext> → public_id
function publicIdFromUrl(url) {
  const m = /\/upload\/(?:.*\/)?v\d+\/(.+?)(?:\.[a-z0-9]+)?$/i.exec(url || '');
  return m ? m[1] : null;
}

async function listAssets() {
  const assets = [];
  let next_cursor;
  do {
    const res = await cloudinary.api.resources({ type: 'upload', prefix: PREFIX, max_results: 500, next_cursor });
    assets.push(...res.resources);
    next_cursor = res.next_cursor;
  } while (next_cursor);
  return assets;
}

async function main() {
  console.log('=== Seven Stars — Relink Product Images ===\n');
  if (!BACKUP_TABLE || !/^products_qb_link_backup_\d+$/.test(BACKUP_TABLE)) {
    throw new Error('Pass the backup table name, e.g. products_qb_link_backup_20261008001527');
  }

  const { rows: backupRows } = await pool.query(`SELECT id, sku FROM ${BACKUP_TABLE}`);
  const { rows: current } = await pool.query('SELECT id, sku, image_url FROM products ORDER BY id');
  const oldById = new Map(backupRows.map(r => [Number(r.id), r]));

  const currentBySku = new Map();
  for (const row of current) {
    const key = skuKey(row.sku);
    if (!currentBySku.has(key)) currentBySku.set(key, []);
    currentBySku.get(key).push(row);
  }

  // Was the backup taken before or after the id reset?
  let sameId = 0, compared = 0;
  for (const old of backupRows) {
    const rows = currentBySku.get(skuKey(old.sku));
    if (!rows || rows.length !== 1) continue;
    compared++;
    if (rows[0].id === old.id) sameId++;
  }
  console.log(`Backup table: ${BACKUP_TABLE} (${backupRows.length} rows)`);
  console.log(`SKUs with the same id in the backup as now: ${sameId} of ${compared}`);
  if (compared && sameId / compared > 0.9 && !FORCE) {
    throw new Error('Backup ids mostly match current ids — it was likely taken AFTER the resync, so it cannot map old ids. Not relinking (use --force to override).');
  }

  const assets = await listAssets();
  console.log(`Cloudinary assets under ${PREFIX}*: ${assets.length}\n`);

  const inUse = new Map(); // public_id → current product using it
  for (const row of current) {
    const pid = publicIdFromUrl(row.image_url);
    if (pid) inUse.set(pid, row);
  }

  const updates = [], alreadyLinked = [], lost = [], noOldRow = [], noProduct = [], ambiguous = [], keptCurrent = [];
  const claimed = new Set();

  for (const asset of assets) {
    const oldId = Number(asset.public_id.slice(PREFIX.length));
    if (!Number.isInteger(oldId)) continue;
    const old = oldById.get(oldId);

    const user = inUse.get(asset.public_id);
    if (user) {
      alreadyLinked.push(asset.public_id);
      if (old && skuKey(old.sku) !== skuKey(user.sku)) lost.push(`${old.sku} (old id ${oldId}) — overwritten by ${user.sku}'s upload`);
      continue;
    }
    if (!old) { noOldRow.push(asset.public_id); continue; }

    const rows = currentBySku.get(skuKey(old.sku));
    if (!rows) { noProduct.push(`${old.sku} (old id ${oldId})`); continue; }
    if (rows.length > 1 || claimed.has(rows[0].id)) { ambiguous.push(old.sku); continue; }
    const target = rows[0];
    if (target.image_url && !FORCE) { keptCurrent.push(target.sku); continue; }

    claimed.add(target.id);
    updates.push({ id: target.id, sku: target.sku, oldId, url: asset.secure_url });
  }

  console.log(`Images to relink: ${updates.length}`);
  for (const u of updates) console.log(`  - ${u.sku}: product-${u.oldId} → product id ${u.id}`);
  console.log(`\nAlready linked (uploaded since the resync): ${alreadyLinked.length}`);
  if (lost.length) {
    console.log(`\n${lost.length} old image(s) were overwritten and can't be recovered — re-upload these:`);
    for (const s of lost) console.log(`  - ${s}`);
  }
  if (keptCurrent.length) {
    console.log(`\n${keptCurrent.length} product(s) already have an image — left alone (use --force to replace):`);
    for (const s of keptCurrent) console.log(`  - ${s}`);
  }
  if (ambiguous.length) {
    console.log(`\n${ambiguous.length} skipped — duplicate sku, fix by hand:`);
    for (const s of ambiguous) console.log(`  - ${s}`);
  }
  if (noProduct.length) {
    console.log(`\n${noProduct.length} image(s) belong to a sku that no longer exists:`);
    for (const s of noProduct) console.log(`  - ${s}`);
  }
  if (noOldRow.length) {
    console.log(`\n${noOldRow.length} image(s) have an id that isn't in the backup table (product created after it was taken):`);
    for (const s of noOldRow) console.log(`  - ${s}`);
  }
  console.log();

  if (!CONFIRMED) {
    console.log('Preview only — re-run with --yes to apply.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of updates) {
      await client.query('UPDATE products SET image_url = $1, updated_at = NOW() WHERE id = $2', [u.url, u.id]);
    }
    await client.query('COMMIT');
    console.log(`Relinked ${updates.length} image(s).`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('\nRelink failed:', err.error?.message || err.message);
  await pool.end();
  process.exit(1);
});

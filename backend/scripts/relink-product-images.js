/**
 * RELINK PRODUCT IMAGES — keeps product images recoverable from Cloudinary
 * alone, independent of products.id or the database.
 *
 * Every upload (productsController.uploadProductImage) tags the asset
 * 'seven-stars-product' and stores the product's sku in its context. This
 * script uses that to:
 *  1. Backfill — any product whose current image_url points at an asset
 *     without the tag (uploaded before tagging existed) gets the tag + sku
 *     written onto that asset, so it is covered from now on.
 *  2. Relink — any product with no image_url gets the newest tagged asset
 *     whose sku matches (case/whitespace-insensitive). Products that already
 *     have an image are left alone unless --force.
 *
 * Run it after any data migration that wipes or rebuilds products
 * (full-resync-from-qb.js already re-attaches image_url by sku itself; this
 * is the fallback when that didn't happen). Running it now and then is also
 * harmless — step 1 just keeps the tags current.
 *
 * Safety:
 *  - Without --yes it only prints what would change — nothing is written,
 *    in Cloudinary or the database.
 *  - Database updates run in a single transaction; only products.image_url
 *    is touched. Nothing is ever deleted from Cloudinary.
 *
 * Usage (run from backend/):
 *   node scripts/relink-product-images.js           # preview
 *   node scripts/relink-product-images.js --yes     # apply
 *   node scripts/relink-product-images.js --yes --force   # also replace existing image_urls
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
const TAG = 'seven-stars-product'; // same as PRODUCT_IMAGE_TAG in productsController.js

function skuKey(sku) {
  return (sku || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// .../upload/[<transforms>/]v<version>/<public_id>.<ext> → public_id
function publicIdFromUrl(url) {
  const m = /\/upload\/(?:.*\/)?v\d+\/(.+?)(?:\.[a-z0-9]+)?$/i.exec(url || '');
  return m ? m[1] : null;
}

async function listTagged() {
  const assets = [];
  let next_cursor;
  do {
    const res = await cloudinary.api.resources_by_tag(TAG, { context: true, max_results: 500, next_cursor });
    assets.push(...res.resources);
    next_cursor = res.next_cursor;
  } while (next_cursor);
  return assets;
}

async function main() {
  console.log('=== Seven Stars — Relink Product Images ===\n');

  const { rows: products } = await pool.query('SELECT id, sku, image_url FROM products ORDER BY id');
  const tagged = await listTagged();
  const taggedIds = new Set(tagged.map(a => a.public_id));
  console.log(`Products: ${products.length}   with image: ${products.filter(p => p.image_url).length}   tagged Cloudinary images: ${tagged.length}\n`);

  // Step 1 — backfill tags onto currently linked, untagged assets.
  const backfill = [];
  for (const p of products) {
    const publicId = publicIdFromUrl(p.image_url);
    if (publicId && !taggedIds.has(publicId)) backfill.push({ publicId, sku: p.sku });
  }
  console.log(`Step 1 — linked images missing the sku tag: ${backfill.length}`);

  // Step 2 — newest tagged asset per sku → products without an image.
  const newestBySku = new Map();
  for (const a of tagged) {
    const key = skuKey(a.context?.custom?.sku);
    if (!key) continue;
    const prev = newestBySku.get(key);
    if (!prev || a.created_at > prev.created_at) newestBySku.set(key, a);
  }
  const relink = [], noImage = [];
  for (const p of products) {
    if (p.image_url && !FORCE) continue;
    const asset = newestBySku.get(skuKey(p.sku));
    if (!asset) { if (!p.image_url) noImage.push(p.sku); continue; }
    if (asset.secure_url !== p.image_url) relink.push({ id: p.id, sku: p.sku, url: asset.secure_url });
  }
  console.log(`Step 2 — products to relink from Cloudinary: ${relink.length}`);
  for (const r of relink) console.log(`  - ${r.sku} (id ${r.id})`);
  console.log(`Products with no image anywhere (upload one if needed): ${noImage.length}\n`);

  if (!CONFIRMED) {
    console.log('Preview only — re-run with --yes to apply.');
    await pool.end();
    return;
  }

  let tagFailures = 0;
  for (const b of backfill) {
    try {
      await cloudinary.uploader.explicit(b.publicId, { type: 'upload', tags: [TAG], context: { sku: b.sku } });
    } catch (err) {
      tagFailures++;
      console.log(`  could not tag ${b.publicId} (${b.sku}): ${err.error?.message || err.message}`);
    }
  }
  console.log(`Tagged ${backfill.length - tagFailures} of ${backfill.length} image(s).`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of relink) {
      await client.query('UPDATE products SET image_url = $1, updated_at = NOW() WHERE id = $2', [r.url, r.id]);
    }
    await client.query('COMMIT');
    console.log(`Relinked ${relink.length} product(s).`);
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

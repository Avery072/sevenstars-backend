/**
 * RESTORE PRODUCT IMAGES — repair tool for a full-resync-from-qb.js run.
 *
 * That script truncates products with RESTART IDENTITY and doesn't carry
 * image_url over, so every product came back with a new id and no image.
 * Images used to be uploaded to Cloudinary as seven-stars-products/product-<id>
 * with overwrite: true, so an upload made after the resync could replace the
 * asset an unrelated old product with the same id pointed at.
 *
 * This re-attaches image_url from the resync's backup file, matched by sku
 * (case/whitespace-insensitive) — NOT by id, which is exactly what changed.
 * A sku that appears more than once on either side is skipped rather than
 * guessed at. A product that already has an image_url (re-uploaded after the
 * resync) is left alone unless --force is given.
 *
 * Before restoring, each backed-up URL's version is compared against the
 * asset's current version in Cloudinary. If they differ, the asset was
 * overwritten after the backup and now shows a different product's picture —
 * those are NOT restored and are listed for re-upload instead.
 *
 * Safety:
 *  - Without --yes it only prints what would change — nothing is written.
 *  - All updates run in a single transaction.
 *  - Only products.image_url is touched.
 *
 * Usage (run from backend/):
 *   node scripts/restore-product-images.js                          # preview, newest backup in scripts/backups/
 *   node scripts/restore-product-images.js path/to/backup.json      # preview, specific backup
 *   node scripts/restore-product-images.js path/to/backup.json --yes
 *   ... --force                  also replace image_urls set since the resync
 *   ... --skip-cloudinary-check  don't query Cloudinary for overwritten assets
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
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
const SKIP_CHECK = args.includes('--skip-cloudinary-check');

function newestBackup() {
  const dir = path.join(__dirname, 'backups');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => /^full-resync-.*\.json$/.test(f)).sort()
    : [];
  if (!files.length) throw new Error(`No full-resync-*.json in ${dir} — pass the backup file path explicitly.`);
  return path.join(dir, files[files.length - 1]);
}

const BACKUP_PATH = path.resolve(args.find(a => !a.startsWith('--')) || newestBackup());

function skuKey(sku) {
  return (sku || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// https://res.cloudinary.com/<cloud>/image/upload/[<transforms>/]v<version>/<public_id>.<ext>
function parseCloudinaryUrl(url) {
  const m = /\/upload\/(?:.*\/)?v(\d+)\/(.+?)(?:\.[a-z0-9]+)?$/i.exec(url || '');
  return m ? { version: Number(m[1]), publicId: m[2] } : null;
}

async function wasOverwritten(url) {
  const parsed = parseCloudinaryUrl(url);
  if (!parsed) return { overwritten: false, note: 'not a recognizable Cloudinary URL' };
  try {
    const res = await cloudinary.api.resource(parsed.publicId);
    return { overwritten: res.version !== parsed.version };
  } catch (err) {
    const code = err.error?.http_code || err.http_code;
    if (code === 404) return { overwritten: true, note: 'asset no longer exists' };
    throw err;
  }
}

async function main() {
  console.log('=== Seven Stars — Restore Product Images ===\n');
  console.log(`Backup: ${BACKUP_PATH}`);

  const backup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
  const backupProducts = Array.isArray(backup) ? backup : backup.products;
  if (!Array.isArray(backupProducts)) throw new Error(`No products array found in ${BACKUP_PATH}`);

  // sku → image_url; a sku seen twice maps to null (ambiguous).
  const imageBySku = new Map();
  for (const p of backupProducts) {
    if (!p.image_url) continue;
    const key = skuKey(p.sku);
    if (!key) continue;
    imageBySku.set(key, imageBySku.has(key) ? null : { sku: p.sku, oldId: p.id, url: p.image_url });
  }

  const { rows: current } = await pool.query('SELECT id, sku, image_url FROM products ORDER BY id');
  const currentBySku = new Map();
  for (const row of current) {
    const key = skuKey(row.sku);
    if (!currentBySku.has(key)) currentBySku.set(key, []);
    currentBySku.get(key).push(row);
  }
  console.log(`Backed-up products with an image: ${imageBySku.size}   Current products: ${current.length}\n`);

  const updates = [];
  const ambiguous = [], unmatched = [], keptCurrent = [], overwritten = [];

  for (const [key, snap] of imageBySku) {
    const rows = currentBySku.get(key);
    if (snap === null || (rows && rows.length > 1)) { ambiguous.push(snap ? snap.sku : key); continue; }
    if (!rows) { unmatched.push(snap.sku); continue; }

    const row = rows[0];
    if (row.image_url === snap.url) continue;
    if (row.image_url && !FORCE) { keptCurrent.push(row.sku); continue; }

    if (!SKIP_CHECK) {
      const check = await wasOverwritten(snap.url);
      if (check.overwritten) {
        overwritten.push(`${row.sku} (new id ${row.id}, old id ${snap.oldId}${check.note ? `, ${check.note}` : ''})`);
        continue;
      }
    }
    updates.push({ id: row.id, sku: row.sku, oldId: snap.oldId, url: snap.url });
  }

  console.log(`Images to restore: ${updates.length}`);
  for (const u of updates) console.log(`  - ${u.sku}: id ${u.oldId} → ${u.id}`);
  if (overwritten.length) {
    console.log(`\n${overwritten.length} image(s) were overwritten in Cloudinary after the backup — NOT restored, re-upload these:`);
    for (const s of overwritten) console.log(`  - ${s}`);
  }
  if (keptCurrent.length) {
    console.log(`\n${keptCurrent.length} product(s) already have a newer image — left alone (use --force to replace):`);
    for (const s of keptCurrent) console.log(`  - ${s}`);
  }
  if (ambiguous.length) {
    console.log(`\n${ambiguous.length} skipped — duplicate sku, fix by hand from the backup:`);
    for (const s of ambiguous) console.log(`  - ${s}`);
  }
  if (unmatched.length) {
    console.log(`\n${unmatched.length} backed-up sku(s) no longer exist as products — image not restored:`);
    for (const s of unmatched) console.log(`  - ${s}`);
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
    console.log(`Restored ${updates.length} image(s).`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('\nRestore failed:', err.message);
  await pool.end();
  process.exit(1);
});

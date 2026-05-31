const pool = require('./src/config/db');

async function test() {
  try {
    const result = await pool.query('SELECT realm_id, expires_at FROM qb_tokens ORDER BY id LIMIT 1');
    const stored = result.rows[0];
    
    if (!stored) {
      console.log('❌ No QB tokens found in database');
      process.exit(1);
    }

    console.log('✅ QB Tokens Found:');
    console.log(`   Realm ID: ${stored.realm_id}`);
    console.log(`   Expires at: ${stored.expires_at}`);
    console.log(`   Valid: ${new Date(stored.expires_at) > new Date() ? 'YES' : 'NO'}`);
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

test();


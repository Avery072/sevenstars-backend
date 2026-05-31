const OAuthClient = require('intuit-oauth');
const pool = require('/root/repo/backend/src/config/db');

const oauthClient = new OAuthClient({
  clientId: process.env.QB_CLIENT_ID,
  clientSecret: process.env.QB_CLIENT_SECRET,
  environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
  redirectUri: process.env.QB_REDIRECT_URI,
});

async function testQBConnection() {
  try {
    // Get stored tokens
    const result = await pool.query('SELECT * FROM qb_tokens ORDER BY id LIMIT 1');
    const stored = result.rows[0];
    
    if (!stored) {
      console.log('❌ No QB tokens found');
      process.exit(1);
    }

    console.log('✅ Found QB tokens');
    console.log(`   Realm ID: ${stored.realm_id}`);
    console.log(`   Expires at: ${stored.expires_at}`);

    // Try to refresh token to verify it's valid
    try {
      const authResponse = await oauthClient.refreshUsingToken(stored.refresh_token);
      const token = authResponse.getJson();
      console.log('✅ Token refresh successful - tokens are valid');
      
      // Now query for items
      const accessToken = token.access_token;
      const realmId = stored.realm_id;
      
      const response = await fetch(
        `https://quickbooks.api.intuit.com/v2/companies/${realmId}/query?query=select * from Item`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
          },
        }
      );

      const data = await response.json();
      
      if (data.QueryResponse && data.QueryResponse.Item) {
        console.log(`\n✅ Found ${data.QueryResponse.Item.length} items in QB:`);
        data.QueryResponse.Item.slice(0, 5).forEach(item => {
          console.log(`   - ${item.Name} (ID: ${item.Id})`);
        });
        if (data.QueryResponse.Item.length > 5) {
          console.log(`   ... and ${data.QueryResponse.Item.length - 5} more`);
        }
      } else {
        console.log('\n⚠️  No items found in QB account');
      }
      
    } catch (err) {
      console.log('❌ Token refresh failed:', err.message);
      process.exit(1);
    }

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

testQBConnection();


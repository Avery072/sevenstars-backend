const pool = require('./src/config/db');

async function testBothAccounts() {
  try {
    const result = await pool.query('SELECT realm_id, access_token, refresh_token FROM qb_tokens ORDER BY id');
    const accounts = result.rows;
    
    if (accounts.length === 0) {
      console.log('❌ No QB tokens found');
      process.exit(1);
    }

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      console.log(`\n📊 Account ${i + 1} (Realm: ${account.realm_id})`);
      console.log('─'.repeat(50));
      
      try {
        const response = await fetch(
          `https://quickbooks.api.intuit.com/v2/companies/${account.realm_id}/query?query=select * from Item`,
          {
            headers: {
              'Authorization': `Bearer ${account.access_token}`,
              'Accept': 'application/json',
            },
          }
        );

        const data = await response.json();
        
        if (data.QueryResponse && data.QueryResponse.Item) {
          console.log(`✅ Found ${data.QueryResponse.Item.length} items:`);
          data.QueryResponse.Item.slice(0, 10).forEach(item => {
            console.log(`   • ${item.Name} (ID: ${item.Id}, Type: ${item.Type})`);
          });
          if (data.QueryResponse.Item.length > 10) {
            console.log(`   ... and ${data.QueryResponse.Item.length - 10} more`);
          }
        } else if (data.fault) {
          console.log(`❌ Error: ${data.fault[0].detail}`);
        } else {
          console.log('⚠️  No items found');
        }
      } catch (err) {
        console.log(`❌ Query failed: ${err.message}`);
      }
    }
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

testBothAccounts();


const pool = require('./src/config/db');
const { getValidAccessToken } = require('./src/config/quickbooks');

async function testCompanyNames() {
  try {
    const result = await pool.query('SELECT realm_id FROM qb_tokens ORDER BY id');
    const accounts = result.rows;
    
    if (accounts.length === 0) {
      console.log('❌ No QB tokens found');
      process.exit(1);
    }

    for (let i = 0; i < accounts.length; i++) {
      const realmId = accounts[i].realm_id;
      console.log(`\n📊 Account ${i + 1} (Realm: ${realmId})`);
      console.log('─'.repeat(50));
      
      try {
        const { accessToken } = await getValidAccessToken();
        console.log(`Token obtained: ${accessToken.substring(0, 50)}...`);
        
        const response = await fetch(
          `https://quickbooks.api.intuit.com/v2/companies/${realmId}/query?query=select * from CompanyInfo`,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Accept': 'application/json',
            },
          }
        );

        console.log(`HTTP Status: ${response.status}`);
        const text = await response.text();
        console.log(`Response (first 200 chars): ${text.substring(0, 200)}`);
        
      } catch (err) {
        console.log(`❌ Failed: ${err.message}`);
      }
    }
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

testCompanyNames();


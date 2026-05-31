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
        
        const response = await fetch(
          `https://quickbooks.api.intuit.com/v2/companies/${realmId}/query?query=select * from CompanyInfo`,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Accept': 'application/json',
            },
          }
        );

        const data = await response.json();
        
        if (data.QueryResponse && data.QueryResponse.CompanyInfo && data.QueryResponse.CompanyInfo.length > 0) {
          const company = data.QueryResponse.CompanyInfo[0];
          console.log(`✅ Company Name: ${company.CompanyName}`);
          console.log(`   Legal Name: ${company.LegalAddr?.City || 'N/A'}`);
        } else if (data.fault) {
          console.log(`❌ Error: ${data.fault[0].detail}`);
        } else {
          console.log('⚠️  Could not retrieve company info');
        }
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


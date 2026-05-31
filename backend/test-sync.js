const pool = require('./src/config/db');
const { queryQBAll } = require('./src/middleware/qbSync');

async function testSync() {
  try {
    console.log('🔄 Testing QB sync...\n');
    
    console.log('📦 Fetching items from QB...');
    const items = await queryQBAll('Item');
    console.log(`✅ Got ${items.length} items`);
    
    console.log('\n👥 Fetching customers from QB...');
    const customers = await queryQBAll('Customer');
    console.log(`✅ Got ${customers.length} customers`);
    
    // Show first few items
    if (items.length > 0) {
      console.log('\n📋 Sample items:');
      items.slice(0, 5).forEach(item => {
        console.log(`   • ${item.Name} (ID: ${item.Id}, Type: ${item.Type})`);
      });
    }
    
    // Show first few customers
    if (customers.length > 0) {
      console.log('\n👥 Sample customers:');
      customers.slice(0, 5).forEach(c => {
        const name = c.CompanyName || `${c.GivenName || ''} ${c.FamilyName || ''}`.trim();
        console.log(`   • ${name} (ID: ${c.Id})`);
      });
    }
    
    console.log('\n✅ Sync test successful!');
    
  } catch (err) {
    console.error('❌ Sync failed:', err.message);
    process.exit(1);
  }
}

testSync();


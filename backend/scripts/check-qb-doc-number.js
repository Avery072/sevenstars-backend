// Read-only diagnostic — checks whether this QBO company has "Custom transaction
// numbers" enabled (which would explain DocNumber coming back blank on invoices
// we create without explicitly supplying one), and shows the DocNumber on the
// 10 most recent invoices. Makes no changes.
require('dotenv').config();
const { getQBClient } = require('../src/middleware/qbSync');

(async () => {
  const client = await getQBClient();

  const { data: prefsData } = await client.get('/preferences?minorversion=65');
  const customTxnNumbers = prefsData?.Preferences?.SalesFormsPrefs?.CustomTxnNumbers;
  console.log('CustomTxnNumbers preference:', customTxnNumbers);
  console.log('(if true, QBO will NOT auto-assign DocNumber when we omit it — we must supply one)');
  console.log('');

  const query = `SELECT Id, DocNumber, TxnDate FROM Invoice ORDERBY Id DESC MAXRESULTS 10`;
  const { data } = await client.get(`/query?query=${encodeURIComponent(query)}&minorversion=65`);
  const invoices = data?.QueryResponse?.Invoice || [];

  console.log('Last 10 invoices (most recent first):');
  for (const inv of invoices) {
    console.log(`  Id=${inv.Id}  DocNumber=${JSON.stringify(inv.DocNumber)}  TxnDate=${inv.TxnDate}`);
  }
})().catch(err => {
  console.error('Check failed:', err.response?.data ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});

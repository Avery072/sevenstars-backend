const pool = require('../config/db');
const { getQBClient } = require('../middleware/qbSync');

// Highest all-digit DocNumber among the most recently created invoices in the
// connected QuickBooks company, or null if there are none. Looks at recent
// invoices only (by creation time, not TxnDate) so one mistyped number from
// years ago can't drag the counter somewhere odd.
async function highestQBDocNumber() {
  const client = await getQBClient();
  const query = 'SELECT Id, DocNumber FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 1000';
  const { data } = await client.get(`/query?query=${encodeURIComponent(query)}&minorversion=65`);
  const numbers = (data?.QueryResponse?.Invoice || [])
    .map(inv => inv.DocNumber)
    .filter(n => /^\d{1,9}$/.test(n || ''))
    .map(Number);
  return numbers.length ? Math.max(...numbers) : null;
}

// The number the next app-created invoice would get.
async function nextDocNumber() {
  const { rows: [seq] } = await pool.query('SELECT last_value, is_called FROM qb_invoice_doc_number_seq');
  return Number(seq.last_value) + (seq.is_called ? 1 : 0);
}

// Where the counter stands against QuickBooks, without changing anything.
async function docNumberCounterStatus() {
  const [qbHighest, next] = await Promise.all([highestQBDocNumber(), nextDocNumber()]);
  return { qbHighest, next, behind: qbHighest !== null && qbHighest >= next };
}

// Moves qb_invoice_doc_number_seq past the highest invoice number QuickBooks
// has, so the next app-created invoice can't collide with one entered there
// while the app wasn't keeping up (outage, data migration, a different QB
// company). Never lowers the counter. GREATEST against the live last_value
// keeps a nextval that lands between the read and the setval from being undone.
async function raiseDocNumberCounter() {
  const { qbHighest, next: previousNext, behind } = await docNumberCounterStatus();
  if (behind) {
    await pool.query(
      `SELECT setval('qb_invoice_doc_number_seq',
                     GREATEST($1::bigint, (SELECT last_value FROM qb_invoice_doc_number_seq)))`,
      [qbHighest]
    );
  }
  return { qbHighest, previousNext, next: await nextDocNumber(), raised: behind };
}

module.exports = { highestQBDocNumber, docNumberCounterStatus, raiseDocNumberCounter };

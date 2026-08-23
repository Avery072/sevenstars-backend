const axios = require('axios');
const { getValidAccessToken } = require('../config/quickbooks');

function formatQBError(err) {
  if (err.response?.data) {
    return JSON.stringify({
      status: err.response.status,
      data: err.response.data,
    });
  }
  return err.stack || err.message || String(err);
}

function logQBError(operation, err) {
  console.error(`${operation} failed:`, formatQBError(err));
}

// Returns an axios instance pre-configured for the QBO API with a fresh token.
async function getQBClient() {
  try {
    const { accessToken, realmId } = await getValidAccessToken();
    const baseURL = `https://quickbooks.api.intuit.com/v3/company/${realmId}`;

    return axios.create({
      baseURL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    logQBError('QB client setup', err);
    throw err;
  }
}

async function fetchQBItem(itemId) {
  try {
    const client = await getQBClient();
    const { data } = await client.get(`/item/${itemId}?minorversion=65`);
    return data.Item;
  } catch (err) {
    logQBError(`QB item fetch ${itemId}`, err);
    throw err;
  }
}

async function fetchQBCustomer(customerId) {
  try {
    const client = await getQBClient();
    const { data } = await client.get(`/customer/${customerId}?minorversion=65`);
    return data.Customer;
  } catch (err) {
    logQBError(`QB customer fetch ${customerId}`, err);
    throw err;
  }
}

async function fetchQBInvoice(invoiceId) {
  try {
    const client = await getQBClient();
    const { data } = await client.get(`/invoice/${invoiceId}?minorversion=65`);
    return data.Invoice;
  } catch (err) {
    logQBError(`QB invoice fetch ${invoiceId}`, err);
    throw err;
  }
}

// This company has "Custom transaction numbers" enabled in QBO, so DocNumber
// must be supplied by the caller — QBO leaves it blank rather than
// auto-assigning one (see checkDocNumberPreference / migration 010). Callers
// draw the next value from qb_invoice_doc_number_seq (atomic, unlike reading
// QBO's last DocNumber and computing +1 client-side, which races).
async function createQBInvoice(invoicePayload) {
  try {
    const client = await getQBClient();
    const { data } = await client.post('/invoice?minorversion=65', invoicePayload);
    return data.Invoice;
  } catch (err) {
    logQBError('QB invoice creation', err);
    throw err;
  }
}

// QBO error code 6140 = "Duplicate Document Number Error" — thrown when the
// DocNumber we supplied collides with one already used (e.g. a staff member
// created an invoice directly in QBO with the same number around the same
// time). Callers can catch this to retry with a fresh number.
function isDuplicateDocNumberError(err) {
  const errors = err.response?.data?.Fault?.Error;
  return Array.isArray(errors) && errors.some(e => e.code === '6140');
}

async function createQBCustomer(customerPayload) {
  try {
    const client = await getQBClient();
    const { data } = await client.post('/customer?minorversion=65', customerPayload);
    return data.Customer;
  } catch (err) {
    logQBError('QB customer creation', err);
    throw err;
  }
}

async function getQBAccounts() {
  try {
    const { realmId } = await getValidAccessToken();
    console.log('getQBAccounts called, realmId:', realmId);
    const client = await getQBClient();
    const query = 'SELECT * FROM Account';
    const { data } = await client.get(`/query?query=${encodeURIComponent(query)}&minorversion=75`);
    return data?.QueryResponse?.Account || [];
  } catch (err) {
    logQBError('QB account query', err);
    throw err;
  }
}

function activeAccount(account) {
  return account.Active !== false;
}

async function getQBInventoryItemAccountRefs() {
  try {
    const accounts = await getQBAccounts();
    const activeAccounts = accounts.filter(activeAccount);
    const assetAccount = activeAccounts.find(a => a.AccountSubType === 'Inventory');
    const incomeAccount = activeAccounts.find(a => a.AccountType === 'Income' && a.Name === 'Sales')
      || activeAccounts.find(a => a.AccountType === 'Income');
    const expenseAccount = activeAccounts.find(a => a.AccountType === 'Cost of Goods Sold');
    const missing = [];

    if (!incomeAccount) missing.push('IncomeAccountRef (AccountType Income)');
    if (!assetAccount) missing.push('AssetAccountRef (AccountSubType Inventory)');
    if (!expenseAccount) missing.push('ExpenseAccountRef (AccountType Cost of Goods Sold)');

    if (missing.length) {
      const error = new Error(`Missing QuickBooks inventory accounts: ${missing.join(', ')}`);
      console.error(error.message);
      throw error;
    }

    console.log('QB inventory accounts selected:', JSON.stringify({
      IncomeAccountRef: `${incomeAccount.Name} (${incomeAccount.Id})`,
      AssetAccountRef: `${assetAccount.Name} (${assetAccount.Id})`,
      ExpenseAccountRef: `${expenseAccount.Name} (${expenseAccount.Id})`,
    }));

    return {
      IncomeAccountRef: { value: incomeAccount.Id, name: incomeAccount.Name },
      AssetAccountRef: { value: assetAccount.Id, name: assetAccount.Name },
      ExpenseAccountRef: { value: expenseAccount.Id, name: expenseAccount.Name },
    };
  } catch (err) {
    logQBError('QB inventory account lookup', err);
    throw err;
  }
}

async function createQBItem(itemPayload) {
  try {
    console.log('createQBItem called with:', JSON.stringify(itemPayload));
    const client = await getQBClient();
    const payload = {
      ...itemPayload,
      Type: itemPayload.Type || 'NonInventory',
    };

    if (payload.Type === 'Inventory') {
      payload.TrackQtyOnHand = true;
    }

    const { data } = await client.post('/item?minorversion=75', payload);
    console.log('QB createItem raw response:', JSON.stringify(data));
    return data.Item;
  } catch (err) {
    logQBError('QB item creation', err);
    throw err;
  }
}

async function getOrCreateQBItemCategory(categoryName) {
  try {
    const category = (categoryName || '').trim();
    if (!category) return null;

    const items = await queryQBAll('Item');
    const existing = items.find(item =>
      item.Type === 'Category'
      && item.Active !== false
      && (item.Name || '').toLowerCase() === category.toLowerCase()
    );
    if (existing) return existing;

    return createQBItem({
      Name: category,
      Type: 'Category',
    });
  } catch (err) {
    logQBError(`QB item category lookup/create ${categoryName}`, err);
    throw err;
  }
}

async function deleteQBInvoice(qbInvoiceId) {
  try {
    const client = await getQBClient();
    const { data } = await client.get(`/invoice/${qbInvoiceId}?minorversion=65`);
    const inv = data.Invoice;
    await client.post(`/invoice?operation=delete&minorversion=65`, {
      Id: inv.Id,
      SyncToken: inv.SyncToken,
    });
    console.log(`QB invoice ${qbInvoiceId} deleted`);
  } catch (err) {
    logQBError(`QB invoice delete ${qbInvoiceId}`, err);
    throw err;
  }
}

// Voids an invoice rather than deleting it — QBO zeroes its amounts and
// prepends "Voided" to PrivateNote (the same signal isVoided() in
// webhooksController already watches for staff-initiated voids done directly
// in QuickBooks), but the transaction itself, its DocNumber, and its line
// history all stay intact for the audit trail. Same fetch-fresh-then-post
// pattern as deleteQBInvoice for the SyncToken.
async function voidQBInvoice(qbInvoiceId) {
  try {
    const client = await getQBClient();
    const { data } = await client.get(`/invoice/${qbInvoiceId}?minorversion=65`);
    const inv = data.Invoice;
    await client.post(`/invoice?operation=void&minorversion=65`, {
      Id: inv.Id,
      SyncToken: inv.SyncToken,
    });
    console.log(`QB invoice ${qbInvoiceId} voided`);
  } catch (err) {
    logQBError(`QB invoice void ${qbInvoiceId}`, err);
    throw err;
  }
}

async function deleteQBItem(qbItemId) {
  try {
    const client = await getQBClient();
    const { data } = await client.get(`/item/${qbItemId}?minorversion=75`);
    const item = data.Item;
    await client.post('/item?minorversion=75', {
      Id: item.Id,
      SyncToken: item.SyncToken,
      Active: false,
      sparse: true,
    });
  } catch (err) {
    const qbError = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('QB item delete failed:', qbError);
  }
}

// Fetches an existing QB invoice and appends new line items to it.
// Must send the full invoice object (not sparse) so QB replaces the Line array correctly.
// Auto-generated lines (SubTotal, Discount) are stripped — QB recalculates them.
async function appendToQBInvoice(invoiceId, newLines) {
  try {
    const client = await getQBClient();
    const { data } = await client.get(`/invoice/${invoiceId}?minorversion=65`);
    const inv = data.Invoice;

    const keepLines = (inv.Line || []).filter(l =>
      l.DetailType === 'SalesItemLineDetail' || l.DetailType === 'DescriptionOnlyLineDetail'
    );

    const { data: updated } = await client.post('/invoice?minorversion=65', {
      ...inv,
      Line: [...keepLines, ...newLines],
    });
    return updated.Invoice;
  } catch (err) {
    logQBError(`QB invoice append ${invoiceId}`, err);
    throw err;
  }
}

// Applies a *targeted* patch to an existing invoice's sales lines — removes
// lines named in removeLineIds, replaces lines named in updateLines (matched
// by Id), appends addLines (no Id) — and leaves every other sales line
// exactly as QB currently has it. This is deliberately not a blind full
// replace: QBO's own Line[] update semantics require resending the complete
// array, but resending a line we didn't intend to touch using our local copy
// of it would silently clobber a concurrent QB-side change to that line
// (e.g. a weight/price correction on a different line of the same invoice,
// made directly in QuickBooks while we're mid-push). Fetching the invoice
// fresh immediately before posting — same pattern as appendToQBInvoice —
// means untouched lines always come from QB's live state, not a possibly-
// stale local copy, and this also keeps QB's own SyncToken check happy.
async function patchQBInvoiceLines(invoiceId, { removeLineIds = [], updateLines = [], addLines = [] } = {}) {
  try {
    const client = await getQBClient();
    const { data } = await client.get(`/invoice/${invoiceId}?minorversion=65`);
    const inv = data.Invoice;

    const removeSet = new Set(removeLineIds);
    const updateMap = new Map(updateLines.map(l => [l.Id, l]));

    const nonSalesLines = (inv.Line || []).filter(l => l.DetailType !== 'SalesItemLineDetail');
    const currentSalesLines = (inv.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail');

    const keptLines = currentSalesLines
      .filter(l => !removeSet.has(l.Id))
      .map(l => updateMap.has(l.Id) ? updateMap.get(l.Id) : l);

    const { data: updated } = await client.post('/invoice?minorversion=65', {
      ...inv,
      Line: [...nonSalesLines, ...keptLines, ...addLines],
    });
    return updated.Invoice;
  } catch (err) {
    logQBError(`QB invoice line patch ${invoiceId}`, err);
    throw err;
  }
}

// Sets a QB Inventory item's QtyOnHand — fetches the item fresh first (for
// Id/SyncToken, QBO's own concurrency check) then a sparse update, same
// fetch-fresh-then-post pattern as appendToQBInvoice/patchQBInvoiceLines.
// Used for the admin "OUT OF STOCK" action — write-through, not local-then-
// push, so a stray webhook can't silently revert the action.
async function setQBItemQuantity(qbItemId, quantity) {
  const item = await fetchQBItem(qbItemId);
  return updateQBItem({
    Id: item.Id,
    SyncToken: item.SyncToken,
    sparse: true,
    QtyOnHand: quantity,
  });
}

async function updateQBItem(itemPayload) {
  try {
    const client = await getQBClient();
    const { data } = await client.post('/item?minorversion=65', itemPayload);
    return data.Item;
  } catch (err) {
    logQBError('QB item update', err);
    throw err;
  }
}

// Fetches all records for a QB entity using paginated SELECT queries.
async function queryQBAll(entity) {
  try {
    const client = await getQBClient();
    const pageSize = 1000;
    let startPosition = 1;
    const results = [];

    while (true) {
      const query = `SELECT * FROM ${entity} MAXRESULTS ${pageSize} STARTPOSITION ${startPosition}`;
      const { data } = await client.get(`/query?query=${encodeURIComponent(query)}&minorversion=65`);
      const rows = data?.QueryResponse?.[entity] || [];
      results.push(...rows);
      if (rows.length < pageSize) break;
      startPosition += pageSize;
    }

    return results;
  } catch (err) {
    logQBError(`QB ${entity} query`, err);
    throw err;
  }
}

module.exports = {
  getQBClient,
  queryQBAll,
  fetchQBItem,
  fetchQBCustomer,
  fetchQBInvoice,
  createQBInvoice,
  appendToQBInvoice,
  patchQBInvoiceLines,
  deleteQBInvoice,
  voidQBInvoice,
  isDuplicateDocNumberError,
  createQBCustomer,
  createQBItem,
  getOrCreateQBItemCategory,
  deleteQBItem,
  getQBAccounts,
  getQBInventoryItemAccountRefs,
  updateQBItem,
  setQBItemQuantity,
};

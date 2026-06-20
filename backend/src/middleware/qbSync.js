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

async function queryQBAccountsByType(accountType) {
  try {
    const client = await getQBClient();
    const query = `SELECT * FROM Account WHERE AccountType = '${accountType}'`;
    const { data } = await client.get(`/query?query=${encodeURIComponent(query)}&minorversion=75`);
    return data?.QueryResponse?.Account || [];
  } catch (err) {
    logQBError(`QB ${accountType} account query`, err);
    throw err;
  }
}

function activeAccount(account) {
  return account.Active !== false;
}

function firstActiveAccount(accounts) {
  return accounts.find(activeAccount);
}

async function getQBInventoryItemAccountRefs() {
  try {
    const [assetAccounts, incomeAccounts, expenseAccounts] = await Promise.all([
      queryQBAccountsByType('OtherCurrentAsset'),
      queryQBAccountsByType('Income'),
      queryQBAccountsByType('Cost of Goods Sold'),
    ]);

    const assetAccount = assetAccounts.find(a => activeAccount(a) && a.AccountSubType === 'Inventory');
    const incomeAccount = firstActiveAccount(incomeAccounts);
    const expenseAccount = firstActiveAccount(expenseAccounts);
    const missing = [];

    if (!incomeAccount) missing.push('IncomeAccountRef');
    if (!assetAccount) missing.push('AssetAccountRef with AccountSubType Inventory');
    if (!expenseAccount) missing.push('ExpenseAccountRef');

    if (missing.length) {
      throw new Error(`Missing QuickBooks inventory accounts: ${missing.join(', ')}`);
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
  createQBCustomer,
  createQBItem,
  deleteQBItem,
  getQBAccounts,
  getQBInventoryItemAccountRefs,
  updateQBItem,
};

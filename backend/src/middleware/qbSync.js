const axios = require('axios');
const { getValidAccessToken } = require('../config/quickbooks');

// Returns an axios instance pre-configured for the QBO API with a fresh token.
async function getQBClient() {
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
}

async function fetchQBItem(itemId) {
  const client = await getQBClient();
  const { data } = await client.get(`/item/${itemId}?minorversion=65`);
  return data.Item;
}

async function fetchQBCustomer(customerId) {
  const client = await getQBClient();
  const { data } = await client.get(`/customer/${customerId}?minorversion=65`);
  return data.Customer;
}

async function fetchQBInvoice(invoiceId) {
  const client = await getQBClient();
  const { data } = await client.get(`/invoice/${invoiceId}?minorversion=65`);
  return data.Invoice;
}

async function createQBInvoice(invoicePayload) {
  const client = await getQBClient();
  const { data } = await client.post('/invoice?minorversion=65', invoicePayload);
  return data.Invoice;
}

async function createQBCustomer(customerPayload) {
  const client = await getQBClient();
  const { data } = await client.post('/customer?minorversion=65', customerPayload);
  return data.Customer;
}

async function getQBAccounts() {
  const { realmId } = await getValidAccessToken();
  console.log('getQBAccounts called, realmId:', realmId);
  const client = await getQBClient();
  const query = 'SELECT * FROM Account';
  const { data } = await client.get(`/query?query=${encodeURIComponent(query)}&minorversion=75`);
  return data?.QueryResponse?.Account || [];
}

function accountLabel(account) {
  return account ? `${account.Name} (${account.Id})` : 'none';
}

function isActiveAccount(account) {
  return account.Active !== false;
}

function normalizeAccountType(value) {
  return (value || '').toLowerCase().replace(/[^a-z]/g, '');
}

function accountNameIncludes(account, text) {
  return (account.Name || '').toLowerCase().includes(text.toLowerCase());
}

function findInventoryItemAccounts(accounts) {
  const activeAccounts = accounts.filter(isActiveAccount);

  const incomeAccount = activeAccounts.find(a => accountNameIncludes(a, 'Sales of Product Income'))
    || activeAccounts.find(a => normalizeAccountType(a.AccountType) === 'income');

  const assetAccount = activeAccounts.find(a => accountNameIncludes(a, 'Inventory Asset'))
    || activeAccounts.find(a => normalizeAccountType(a.AccountSubType) === 'inventory')
    || activeAccounts.find(a =>
      normalizeAccountType(a.AccountType) === 'othercurrentasset' && accountNameIncludes(a, 'inventory')
    );

  const expenseAccount = activeAccounts.find(a => accountNameIncludes(a, 'Cost of Goods Sold'))
    || activeAccounts.find(a => normalizeAccountType(a.AccountType) === 'costofgoodssold')
    || activeAccounts.find(a => normalizeAccountType(a.AccountType) === 'expense' && accountNameIncludes(a, 'cost'));

  return { incomeAccount, assetAccount, expenseAccount };
}

async function getQBInventoryItemAccountRefs() {
  const accounts = await getQBAccounts();
  const { incomeAccount, assetAccount, expenseAccount } = findInventoryItemAccounts(accounts);
  const missing = [];

  if (!incomeAccount) missing.push('IncomeAccountRef');
  if (!assetAccount) missing.push('AssetAccountRef');
  if (!expenseAccount) missing.push('ExpenseAccountRef');

  if (missing.length) {
    const available = accounts
      .filter(isActiveAccount)
      .map(a => `${a.Name} (${a.Id}, ${a.AccountType || 'unknown'}, ${a.AccountSubType || 'unknown'})`)
      .join('; ');
    throw new Error(
      `Missing QuickBooks inventory account refs: ${missing.join(', ')}. Active accounts: ${available || 'none'}`
    );
  }

  console.log('QB inventory accounts selected:', JSON.stringify({
    IncomeAccountRef: accountLabel(incomeAccount),
    AssetAccountRef: accountLabel(assetAccount),
    ExpenseAccountRef: accountLabel(expenseAccount),
  }));

  return {
    IncomeAccountRef: { value: incomeAccount.Id, name: incomeAccount.Name },
    AssetAccountRef: { value: assetAccount.Id, name: assetAccount.Name },
    ExpenseAccountRef: { value: expenseAccount.Id, name: expenseAccount.Name },
  };
}

async function createQBItem(itemPayload) {
  console.log('createQBItem called with:', JSON.stringify(itemPayload));
  const client = await getQBClient();
  const payload = {
    ...itemPayload,
    Type: itemPayload.Type || 'NonInventory',
  };

  const { data } = await client.post('/item?minorversion=75', payload);
  console.log('QB createItem raw response:', JSON.stringify(data));
  return data.Item;
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
}

async function updateQBItem(itemPayload) {
  const client = await getQBClient();
  const { data } = await client.post('/item?minorversion=65', itemPayload);
  return data.Item;
}

// Fetches all records for a QB entity using paginated SELECT queries.
async function queryQBAll(entity) {
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

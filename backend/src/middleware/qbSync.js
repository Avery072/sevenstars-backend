const axios = require('axios');
const { getValidAccessToken } = require('../config/quickbooks');

// Returns an axios instance pre-configured for the QBO API with a fresh token.
async function getQBClient() {
  const { accessToken, realmId } = await getValidAccessToken();
  const baseURL = process.env.NODE_ENV === 'production'
    ? `https://quickbooks.api.intuit.com/v3/company/${realmId}`
    : `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}`;

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

async function createQBItem(itemPayload) {
  const client = await getQBClient();
  const { data } = await client.post('/item?minorversion=65', itemPayload);
  return data.Item;
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
  createQBCustomer,
  createQBItem,
  updateQBItem,
};

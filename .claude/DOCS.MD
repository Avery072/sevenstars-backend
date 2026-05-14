# Seven Star Food — Full Technical Documentation

---

## Overview

Seven Star Food is a wholesale seafood distributor admin system. The backend is a Node.js/Express REST API that:
- Manages orders, products, and customers in a local PostgreSQL database
- Syncs bidirectionally with QuickBooks Online (sandbox or production)
- Serves a single-page admin portal at `http://localhost:3001`

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js v22 |
| Framework | Express 4 |
| Database | PostgreSQL (via `pg` pool) |
| QB Integration | `intuit-oauth` + direct QB REST API (axios) |
| Auth | JWT (8h expiry) via `jsonwebtoken` |
| Password hashing | `bcryptjs` |
| Frontend | Vanilla HTML/CSS/JS (single file, served statically) |
| Dev server | `nodemon` |

---

## Folder Structure

```
seven-stars-food/
├── backend/
│   ├── src/
│   │   ├── app.js                  Entry point — mounts routes, starts server
│   │   ├── config/
│   │   │   ├── db.js               PostgreSQL pool (reads DATABASE_URL)
│   │   │   └── quickbooks.js       QB OAuth client + token store + auto-refresh
│   │   ├── routes/                 Thin Express routers — just wire URL to controller
│   │   │   ├── auth.js
│   │   │   ├── orders.js
│   │   │   ├── products.js
│   │   │   ├── customers.js
│   │   │   ├── admin.js
│   │   │   └── webhooks.js
│   │   ├── controllers/            Business logic — one file per resource
│   │   │   ├── authController.js
│   │   │   ├── ordersController.js
│   │   │   ├── productsController.js
│   │   │   ├── customersController.js
│   │   │   ├── syncController.js
│   │   │   └── webhooksController.js
│   │   └── middleware/
│   │       ├── auth.js             JWT verification middleware (requireAuth)
│   │       └── qbSync.js           QB API helpers (axios wrappers)
│   ├── public/
│   │   └── index.html              Admin portal frontend (served statically)
│   ├── migrations/
│   │   └── 001_initial_schema.sql  Full DB schema
│   ├── seed-admin.js               One-time script to create admin user
│   ├── .env                        Environment variables (never commit)
│   ├── .env.example                Template for .env
│   └── package.json
└── .claude/
    ├── todo.MD                     Roadmap and known issues
    └── DOCS.MD                     This file
```

---

## Database Schema

### `qb_tokens`
Stores QuickBooks OAuth tokens. One row per QB realm (company). Auto-refreshed before every QB API call.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL | Primary key |
| realm_id | TEXT UNIQUE | QB company ID |
| access_token | TEXT | Short-lived (1 hour) |
| refresh_token | TEXT | Long-lived (100 days) |
| expires_at | TIMESTAMPTZ | When access_token expires |
| updated_at | TIMESTAMPTZ | Last refresh time |

### `customers`
Mirrored from QB, extended with Seven Star-specific fields.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL | Primary key |
| qb_customer_id | TEXT UNIQUE | QB's customer ID — null for manually created |
| company_name | TEXT NOT NULL | Restaurant name |
| first_name, last_name | TEXT | Contact person |
| phone, email | TEXT | |
| language_pref | TEXT | Default: English |
| ordering_method | TEXT | Default: Mobile App |
| salmon_cut | TEXT | D-Trim / Half / Half-Cut / Bags / N/A |
| skin_off | BOOL | Salmon prep spec |
| scale | BOOL | Salmon prep spec |
| pbo_hg | BOOL | Pin bone out, head & gut |
| notes | TEXT | Delivery / special instructions |
| active | BOOL | false = soft deleted or pending approval |
| created_at | TIMESTAMPTZ | |

### `products`
Mirrored from QB Items, extended with show_price flag.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL | Primary key |
| qb_item_id | TEXT UNIQUE | QB's item ID |
| sku | TEXT NOT NULL | Product code |
| description | TEXT NOT NULL | Full product name |
| category | TEXT | Seafood - Fresh / Frozen / Produce / Pantry |
| unit | TEXT NOT NULL | lb / ea / CA / kg |
| cost | NUMERIC(10,2) | Purchase cost |
| price | NUMERIC(10,2) | Sale price |
| show_price | BOOL | false = mobile shows "Market Price" |
| quantity_on_hand | NUMERIC(10,2) | |
| reorder_point | NUMERIC(10,2) | Triggers LOW badge in UI |
| vendor | TEXT | Supplier name |
| active | BOOL | false = soft deleted |
| updated_at | TIMESTAMPTZ | |

### `orders`
Rolling 3-day window. Hard-deleted after 3 days on server startup and daily.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL | Primary key |
| qb_invoice_id | TEXT UNIQUE | Set after QB invoice push succeeds |
| customer_id | INT → customers | |
| delivery_date | DATE NOT NULL | |
| order_placed_at | TIMESTAMPTZ | Auto-set to NOW() |
| notes | TEXT | General order notes |
| total | NUMERIC(10,2) | Computed from line items on create |

### `order_items`
Cascade-deleted when parent order is deleted.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL | Primary key |
| order_id | INT → orders CASCADE | |
| product_id | INT → products | |
| quantity | NUMERIC(10,2) NOT NULL | |
| unit | TEXT NOT NULL | |
| unit_price | NUMERIC(10,2) | |
| notes | TEXT | Per-item notes (cut instructions, etc.) |

### `admin_users`
Single admin account. No UI to create more — requires raw SQL.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL | Primary key |
| username | TEXT UNIQUE | |
| password_hash | TEXT | bcrypt hash |
| created_at | TIMESTAMPTZ | |

---

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string e.g. `postgresql://localhost:5432/seven_stars_food` |
| `JWT_SECRET` | Long random string for signing JWTs. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `QB_CLIENT_ID` | From QB developer portal → your app → Keys & Credentials → Sandbox |
| `QB_CLIENT_SECRET` | Same location |
| `QB_REDIRECT_URI` | Must match exactly what's in QB portal. Local: `http://localhost:3001/api/auth/qb/callback` |
| `QB_WEBHOOK_VERIFIER_TOKEN` | From QB developer portal → Webhooks tab. Leave blank for local dev. |
| `NODE_ENV` | `development` = QB sandbox endpoints. `production` = live QB endpoints. |
| `PORT` | Default 3001 |

---

## API Reference

All routes under `/api/`. Routes marked **[JWT]** require `Authorization: Bearer <token>` header.

### Auth

#### `POST /api/auth/login`
Admin login. Returns JWT valid for 8 hours.

**Request body:**
```json
{ "username": "admin", "password": "yourpassword" }
```
**Response:**
```json
{ "token": "eyJ..." }
```

#### `GET /api/auth/qb`
Starts QuickBooks OAuth flow. Open in browser — redirects to Intuit login page.

#### `GET /api/auth/qb/callback`
QB OAuth callback. QB redirects here after authorization. Stores tokens in `qb_tokens` table. Returns `{ "message": "QuickBooks connected successfully" }`.

---

### Orders [JWT]

#### `GET /api/orders`
Returns all orders with delivery_date in the last 3 days, ordered by delivery_date DESC.

Optional query param: `?date=YYYY-MM-DD` — returns orders for a specific delivery date.

**Response:** Array of order rows joined with customer name fields.
```json
[
  {
    "id": 1,
    "qb_invoice_id": "1001",
    "customer_id": 3,
    "delivery_date": "2026-05-11",
    "order_placed_at": "2026-05-10T23:48:00Z",
    "notes": null,
    "total": "487.00",
    "company_name": "AA Sushi",
    "first_name": "Anthony",
    "last_name": "Christianto"
  }
]
```

#### `GET /api/orders/:id`
Returns a single order with full line items and customer salmon cut specs.

**Response:**
```json
{
  "id": 1,
  "company_name": "AA Sushi",
  "salmon_cut": "D-Trim",
  "skin_off": true,
  "scale": true,
  "pbo_hg": false,
  "items": [
    {
      "id": 1,
      "product_id": 5,
      "sku": "CSALMON",
      "description": "Salmon Fillet",
      "quantity": "10.00",
      "unit": "lb",
      "unit_price": "22.50",
      "notes": null
    }
  ]
}
```

#### `POST /api/orders`
Creates a new order. Also fires async QB invoice push — logs success/failure to console.

**Request body:**
```json
{
  "customer_id": 3,
  "delivery_date": "2026-05-12",
  "notes": "D-Trim, Skin Off",
  "items": [
    {
      "product_id": 5,
      "quantity": 10,
      "unit": "lb",
      "unit_price": 22.50
    }
  ]
}
```
**Response:** Created order row (201).

---

### Products [JWT]

#### `GET /api/products`
Returns all active products ordered by description.

#### `POST /api/products`
Creates a new product. Also pushes to QB as a new Item asynchronously.

**Request body:**
```json
{
  "sku": "CSALMON",
  "description": "Salmon Fillet",
  "category": "Seafood - Fresh",
  "unit": "lb",
  "cost": 18.00,
  "price": 22.50,
  "show_price": false,
  "quantity_on_hand": 0,
  "reorder_point": 20,
  "vendor": "Mutual Trading"
}
```

#### `PATCH /api/products/:id`
Updates any product fields. Send only the fields you want to change.

#### `PATCH /api/products/:id/show-price`
Toggles the market price visibility flag.

**Request body:** `{ "show_price": false }`

#### `DELETE /api/products/:id`
Soft deletes the product (sets `active = false`).

---

### Customers [JWT]

#### `GET /api/customers`
Returns all active customers ordered by company_name.

#### `GET /api/customers/:id`
Returns a single customer with all fields including salmon cut specs.

#### `POST /api/customers`
Creates a new customer.

**Request body:**
```json
{
  "company_name": "AA Sushi",
  "first_name": "Anthony",
  "last_name": "Christianto",
  "phone": "425-344-4398",
  "email": "contact@aasushi.com",
  "language_pref": "English",
  "ordering_method": "Mobile App",
  "salmon_cut": "D-Trim",
  "skin_off": true,
  "scale": true,
  "pbo_hg": false,
  "notes": null
}
```

#### `PATCH /api/customers/:id`
Updates any customer fields. Send only fields to change. Supports all columns including `active`.

---

### Admin [JWT]

#### `POST /api/admin/sync-from-qb`
Full sync — pulls all QB Items and Customers and upserts into local DB. Safe to run repeatedly. Returns counts of synced records.

**Response:**
```json
{ "message": "Sync complete", "items_synced": 18, "customers_synced": 29 }
```

---

### Webhooks (no JWT — signature verified)

#### `POST /api/webhooks/quickbooks`
Receives QB change events. Responds 200 immediately, then processes async.

Handles:
- `Item` changes → upserts into `products`
- `Invoice` changes → updates `orders.qb_invoice_id`
- `Customer` changes → upserts into `customers`

Signature verified with `HMAC-SHA256(rawBody, QB_WEBHOOK_VERIFIER_TOKEN)` against `intuit-signature` header.

---

## File & Function Reference

### `src/app.js`
Entry point. Mounts all middleware and routes, starts the HTTP server, runs `purgeOldOrders()` on startup and every 24 hours.

### `src/config/db.js`
Exports a `pg.Pool` instance connected via `DATABASE_URL`. Import this anywhere you need to query the DB.

### `src/config/quickbooks.js`

| Function | Purpose |
|---|---|
| `oauthClient` | Configured `intuit-oauth` instance (sandbox or production based on NODE_ENV) |
| `getStoredTokens()` | Reads the first row from `qb_tokens` |
| `saveTokens({ realmId, accessToken, refreshToken, expiresAt })` | Upserts into `qb_tokens` — safe to call repeatedly |
| `getValidAccessToken()` | Returns `{ accessToken, realmId }`. If token expires within 5 minutes, refreshes it first and saves the new tokens. |

### `src/middleware/auth.js`
Exports `requireAuth` — Express middleware that reads `Authorization: Bearer <token>`, verifies it with `JWT_SECRET`, and attaches `req.user = { id, username }`. Returns 401 if missing or invalid.

### `src/middleware/qbSync.js`

| Function | Purpose |
|---|---|
| `getQBClient()` | Returns an axios instance pre-configured with a valid Bearer token and the correct QB base URL |
| `fetchQBItem(itemId)` | GET a single QB Item by ID |
| `fetchQBCustomer(customerId)` | GET a single QB Customer by ID |
| `fetchQBInvoice(invoiceId)` | GET a single QB Invoice by ID |
| `createQBInvoice(payload)` | POST a new invoice to QB. Payload must include `CustomerRef`, `TxnDate`, and `Line` array. |
| `createQBItem(payload)` | POST a new item to QB |
| `updateQBItem(payload)` | POST an item update to QB (QB uses POST for updates, not PUT) |
| `queryQBAll(entity)` | Paginated SELECT * query for any QB entity (Item, Customer, Invoice, etc.). Returns full array. |

### `src/controllers/authController.js`

| Function | Purpose |
|---|---|
| `login(req, res)` | Verifies username/password with bcrypt, returns signed JWT |
| `startQBOAuth(req, res)` | Builds and redirects to the Intuit authorization URL |
| `qbOAuthCallback(req, res)` | Exchanges the auth code for tokens, saves to `qb_tokens` |

### `src/controllers/ordersController.js`

| Function | Purpose |
|---|---|
| `listOrders(req, res)` | Returns orders for last 3 days (or specific date via `?date=`) joined with customer name |
| `getOrder(req, res)` | Returns single order + line items + customer cut specs |
| `createOrder(req, res)` | Inserts order + line items in a transaction, then fires `pushToQB()` async |
| `pushToQB(order, items)` | Builds QB invoice payload from DB data and calls `createQBInvoice()`. Updates `qb_invoice_id` on success. Logs errors without crashing. |
| `purgeOldOrders()` | Deletes orders with delivery_date older than 3 days. Called on startup and every 24h. |

### `src/controllers/productsController.js`

| Function | Purpose |
|---|---|
| `listProducts(req, res)` | Returns all active products |
| `createProduct(req, res)` | Inserts product, pushes to QB async |
| `updateProduct(req, res)` | Dynamic PATCH — only updates fields present in request body |
| `toggleShowPrice(req, res)` | Flips `show_price` boolean |
| `deleteProduct(req, res)` | Soft delete — sets `active = false` |

### `src/controllers/customersController.js`

| Function | Purpose |
|---|---|
| `listCustomers(req, res)` | Returns all active customers ordered by company_name |
| `getCustomer(req, res)` | Returns single customer by ID |
| `createCustomer(req, res)` | Inserts customer with all fields including salmon cut specs |
| `updateCustomer(req, res)` | Dynamic PATCH — only updates fields present in request body |

### `src/controllers/syncController.js`

| Function | Purpose |
|---|---|
| `syncFromQB(req, res)` | Orchestrates full sync — calls `queryQBAll` for Items and Customers in parallel, then upserts both |
| `upsertItems(items)` | Loops QB Item array, inserts or updates each in `products` table |
| `upsertCustomers(customers)` | Loops QB Customer array, inserts or updates each in `customers` table |

### `src/controllers/webhooksController.js`
Handles incoming QB webhook events. Verifies HMAC signature, responds 200 immediately, then dispatches to sync handlers based on entity type (Item, Invoice, Customer).

### `public/index.html`
Single-page admin portal. Self-contained — all CSS, HTML, and JavaScript in one file. No framework, no build step.

Key JS functions:

| Function | Purpose |
|---|---|
| `doLogin()` | POSTs credentials, stores JWT in localStorage |
| `logout()` | Clears localStorage token, shows login screen |
| `api(path, opts)` | Fetch wrapper that attaches Bearer token. Auto-logs out on 401. |
| `loadAll()` | Fetches products, customers, orders in parallel on startup |
| `renderOrders()` | Renders order cards from `allOrders` array |
| `renderProducts(q)` | Renders product table, optionally filtered by search query |
| `renderCustomers(q)` | Renders customer table |
| `renderSalmonCuts(q)` | Renders cut specs table — filters customers where `salmon_cut` is set |
| `renderInventory()` | Renders inventory table with stock status badges from product quantities |
| `loadPackingReport()` | Fetches orders for selected date + all order details, renders packing sheet, stores in `currentPackingData` |
| `exportPackingPDF()` | Generates print-optimized HTML from `currentPackingData`, opens in new tab, triggers print dialog |
| `submitOrder()` | Reads modal form, POSTs to `/api/orders`, refreshes orders panel |
| `submitCustomer()` | Reads modal form, POSTs to `/api/customers`, refreshes customers panel |
| `pushToQB(order, items)` | (Backend only) Builds QB invoice payload, calls QB API, updates `qb_invoice_id` |

### `seed-admin.js`
One-time setup script. Creates (or replaces) the `admin` user with a bcrypt-hashed password. Run with `node seed-admin.js` from the `backend/` directory.

---

## QuickBooks OAuth Flow

```
Browser                     Your Server                  Intuit
  |                              |                           |
  |-- GET /api/auth/qb --------> |                           |
  |                              |-- redirect to Intuit ---> |
  |<-----------------------------|                           |
  |                              |                   User logs in
  |                              |                   and authorizes
  |                              |<-- redirect with ?code= --|
  |                              |                           |
  |                              |-- POST token exchange --> |
  |                              |<-- access + refresh token-|
  |                              |                           |
  |                              |-- save to qb_tokens ----> DB
  |<-- "QB connected" ---------- |
```

Token auto-refresh: before every QB API call, `getValidAccessToken()` checks `expires_at`. If it expires within 5 minutes, it calls `oauthClient.refresh()`, gets new tokens, and saves them. The calling code never needs to handle this — it just calls `getValidAccessToken()` and gets a valid token back.

---

## Order → QB Invoice Flow

```
Admin UI / Mobile App
  |
  POST /api/orders
  |
  ordersController.createOrder()
    ├── BEGIN transaction
    ├── INSERT into orders
    ├── INSERT into order_items (loop)
    ├── COMMIT
    └── fire pushToQB() async (no await — response sent immediately)
          |
          pushToQB()
            ├── SELECT qb_customer_id from customers
            ├── SELECT qb_item_id from products
            ├── Build QB invoice payload
            ├── POST /invoice to QB API
            └── UPDATE orders SET qb_invoice_id = QB's invoice ID
```

If `pushToQB()` fails (QB down, customer has no qb_customer_id, etc.), the error is logged to console and the order remains in the DB without a `qb_invoice_id`. No retry mechanism currently — see todo.

---

## Local Setup (quick reference)

```bash
# 1. Install dependencies
cd backend && npm install

# 2. Set up environment
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REDIRECT_URI

# 3. Create database and run migration
createdb seven_stars_food
psql postgresql://localhost:5432/seven_stars_food -f migrations/001_initial_schema.sql

# 4. Seed admin user
node seed-admin.js

# 5. Start server
npm run dev

# 6. Connect QuickBooks (in browser)
# http://localhost:3001/api/auth/qb

# 7. Sync data from QB
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type:application/json" \
  -d '{"username":"admin","password":"test123"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

curl -X POST http://localhost:3001/api/admin/sync-from-qb \
  -H "Authorization:Bearer $TOKEN"

# 8. Open admin portal
# http://localhost:3001
```
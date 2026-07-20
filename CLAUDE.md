# Seven Star Food — Project Context

Wholesale seafood distributor admin system. Node.js/Express backend + PostgreSQL + QuickBooks Online sync. Admin portal for order management and customer records.

---

## Tech Stack

- **Runtime:** Node.js + Express
- **Database:** PostgreSQL (`pg`)
- **QB Integration:** `intuit-oauth` + `node-quickbooks` — **QuickBooks Online only** (sandbox for testing)
- **Auth:** JWT (8h) for admin sessions, OAuth2 for QuickBooks
- **Hosting target:** Railway / Render / Fly.io

---

## Folder Structure

```
backend/
├── src/
│   ├── config/
│   │   ├── db.js              # pg Pool via DATABASE_URL
│   │   └── quickbooks.js      # QB OAuth client, token store, auto-refresh
│   ├── routes/                # Thin Express routers
│   ├── controllers/           # Business logic
│   ├── middleware/
│   │   ├── auth.js            # JWT verification (requireAuth)
│   │   └── qbSync.js          # QB API helpers (fetchQBItem, createQBInvoice, etc.)
│   └── app.js                 # Entry point — mounts routes, runs daily order purge
├── migrations/
│   └── 001_initial_schema.sql
├── .env.example
└── package.json
```

---

## Database Schema

```sql
-- QB OAuth tokens (one row per realm, auto-refreshed)
qb_tokens (id, realm_id UNIQUE, access_token, refresh_token, expires_at, updated_at)

-- Customers (mirrored from QB, extended with Seven Star fields)
customers (id, qb_customer_id UNIQUE, company_name, first_name, last_name,
           phone, email, language_pref, ordering_method,
           salmon_cut,   -- D-Trim | Half | Half-Cut | Bags | N/A
           skin_off BOOL, scale BOOL, pbo_hg BOOL,
           notes, active, created_at)

-- Products (mirrored from QB Items)
products (id, qb_item_id UNIQUE, sku, description, category, unit,
          cost, price, show_price BOOL,   -- FALSE → mobile shows "Market Price"
          quantity_on_hand, reorder_point, vendor, active, updated_at)

-- Orders (auto-purged after 3 days on server startup + daily)
orders (id, qb_invoice_id UNIQUE, customer_id → customers,
        delivery_date DATE, order_placed_at, notes, total)

-- Order line items (CASCADE delete with order)
order_items (id, order_id → orders, product_id → products,
             quantity, unit, unit_price, notes)

-- Admin users
admin_users (id, username UNIQUE, password_hash, created_at)
```

---

## API Routes

```
AUTH
  POST  /api/auth/login          Admin login → JWT
  GET   /api/auth/qb             Start QB OAuth flow
  GET   /api/auth/qb/callback    QB OAuth callback → store tokens

ORDERS  (all require JWT)
  GET   /api/orders              Last 3 days by delivery_date DESC (default)
        ?date=YYYY-MM-DD         Specific delivery date
        ?from=YYYY-MM-DD&to=YYYY-MM-DD  Explicit date range (admin portal's Today/3 Days/Week/Month filter)
  GET   /api/orders/:id          Order + line items + customer cut prefs
  POST  /api/orders              Manual order entry

PRODUCTS  (all require JWT)
  GET   /api/products            All active products
  POST  /api/products            Create product (also pushes to QB async)
  PATCH /api/products/:id        Edit product fields
  PATCH /api/products/:id/show-price  Toggle market-price visibility
  DELETE /api/products/:id       Soft delete (active = false)

CUSTOMERS  (all require JWT)
  GET   /api/customers           All active customers
  GET   /api/customers/:id       Customer + salmon cut spec
  POST  /api/customers           Create customer
  PATCH /api/customers/:id       Edit customer / cut preferences

ADMIN  (require JWT)
  POST  /api/admin/sync-from-qb  Full initial sync — pulls all QB Items + Customers and upserts locally

WEBHOOKS  (no JWT — signature-verified)
  POST  /api/webhooks/quickbooks QB change events (Item / Invoice / Customer)
```

---

## Key Design Decisions

### Orders — flat history, no admin editing of order state
- The admin view is a flat read-only history; `status` (`active`/`modified`/`voided`) only ever changes via QB webhook/sync, never directly by an admin.
- Default query (no `from`/`to`/`date`) returns `delivery_date BETWEEN CURRENT_DATE - 2 days AND CURRENT_DATE` (3-day rolling window) — the admin portal's date-range filter (Today/3 Days/Week/Month, past or future) passes explicit `from`/`to` instead, computed client-side in local time.
- On server startup and every 24 hours, orders older than **31 days** are hard-deleted (cascade removes line items) — kept just past a month so the "past month" filter never loses data at its own edge.

### Market price toggle (`show_price`)
- `show_price = FALSE` → mobile app renders "Market Price" instead of a number.
- Admin portal always sees the real price regardless of this flag.

### QuickBooks token refresh
- `qb_tokens` holds one row per realm. Before any QB API call, `getValidAccessToken()` checks `expires_at`; if within 5 minutes, it refreshes and updates the row automatically.
- Upsert uses `ON CONFLICT (realm_id)` — safe to call repeatedly.

### QB Webhook flow
- Handler responds `200` immediately before processing (QB requires fast response).
- Async handler syncs: `Item` → products table, `Invoice` → orders.qb_invoice_id, `Customer` → customers table.
- Signature verified with `HMAC-SHA256(body, QB_WEBHOOK_VERIFIER_TOKEN)` against `intuit-signature` header.

---

## Environment Variables

```
DATABASE_URL=postgresql://...
JWT_SECRET=                        # long random string
QB_CLIENT_ID=
QB_CLIENT_SECRET=
QB_REDIRECT_URI=https://yourdomain.com/api/auth/qb/callback
QB_WEBHOOK_VERIFIER_TOKEN=         # from QB developer portal
NODE_ENV=development               # use 'sandbox' QB endpoints in dev
PORT=3001
```

---

## First-Run Checklist

1. Copy `.env.example` → `.env` and fill in values
2. Run migration: `psql $DATABASE_URL -f migrations/001_initial_schema.sql`
3. Seed an admin user:
   ```sql
   INSERT INTO admin_users (username, password_hash)
   VALUES ('admin', crypt('yourpassword', gen_salt('bf')));
   ```
   *(requires `pgcrypto` extension — or hash with bcryptjs in a one-off script)*
4. `npm install && npm run dev`
5. Open `GET /api/auth/qb` in a browser to complete QB OAuth

---

## QB Sandbox Notes
- App is currently wired to QBO sandbox for testing.
- `NODE_ENV=development` → `intuit-oauth` uses `https://sandbox-quickbooks.api.intuit.com`.
- Switch to `NODE_ENV=production` for live QB data.

 DATABASE_URL                                                                                                                                       
  Your PostgreSQL connection string. Format: postgresql://username:password@host:port/dbname                                                         
  - If running locally: install Postgres, create a DB (createdb seven_stars_food), and it'll be postgresql://localhost:5432/seven_stars_food (no     
  user/pass if using your system user)                                                                                                               
  - If using Railway/Render/Fly.io: they generate this for you automatically when you add a Postgres plugin — just copy it from their dashboard      
                                                                                                                                                     
  JWT_SECRET                                                                                                                                         
  Any long random string you generate yourself. Run this in your terminal:
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"                                                                           
  Copy the output. Never share it.                                                                                                                   
   
  QB_CLIENT_ID and QB_CLIENT_SECRET                                                                                                                  
  1. Go to developer.intuit.com                             
  2. Sign in with your Intuit/QuickBooks account                                                                                                     
  3. Click Dashboard → Create an App → QuickBooks Online and Payments
  4. Name it (e.g. "Seven Stars Food")                                                                                                               
  5. Go to Keys & credentials tab                                                                                                                    
  6. You'll see Client ID and Client Secret — there are two sets, use the Sandbox ones for now
                                                                                                                                                     
  QB_REDIRECT_URI                                                                                                                                    
  The URL QB sends the user back to after they authorize. For local testing use:                                                                     
  http://localhost:3001/api/auth/qb/callback                                                                                                         
  You must also add this exact URL in the QB developer portal under Redirect URIs (same Keys & credentials page), otherwise OAuth will reject it.
                                                                                                                                                     
  QB_WEBHOOK_VERIFIER_TOKEN                                                                                                                          
  1. In the QB developer portal, go to Webhooks tab
  2. Add your webhook endpoint URL (e.g. https://yourdomain.com/api/webhooks/quickbooks)                                                             
  3. QB will show you a Verifier Token — copy that                                      
  4. Note: webhooks require a public HTTPS URL, so this won't work on localhost without a tunnel (like ngrok). You can skip it for now during initial
   testing.                              
                                                                                                                                                     
  NODE_ENV                               
  Leave as development while testing with the sandbox. Change to production when you go live.                                                        
                                                                                                                                                     
  PORT
  Leave as 3001 unless something else on your machine is already using that port.                                                                    
                                                                                                                                                     
  ---
  Quickest path to get started locally:                                                                                                              
  1. Set up Postgres and fill in DATABASE_URL                                                                                                        
  2. Generate JWT_SECRET                     
  3. Create the QB app on developer.intuit.com, grab the sandbox Client ID/Secret, set redirect URI to http://localhost:3001/api/auth/qb/callback    
  4. Leave QB_WEBHOOK_VERIFIER_TOKEN blank for now                                                                                               
  5. Run the migration and start the server                      
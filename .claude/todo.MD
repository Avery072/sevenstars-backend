# Seven Star Food — TODO & Roadmap

---

## Phase 1 — Local Dev (Current)

### ✅ Completed
- [x] Backend scaffold (Express + PostgreSQL)
- [x] JWT admin auth
- [x] QB OAuth2 connect + token auto-refresh
- [x] Full QB sync (products + customers)
- [x] Orders CRUD with line items
- [x] QB invoice push on order create (async, fire-and-forget)
- [x] Sync pending invoices button (retry failed QB pushes)
- [x] Admin portal frontend (login, orders, products, customers, salmon cuts, inventory)
- [x] Packing report with Export PDF

---

### 🔧 In Progress / Up Next (Local)

#### 1. Merge Products + Inventory into One Panel
Products and Inventory panels show the same data. Combine into a single **Products** panel that includes:
- All product fields (SKU, description, unit, cost, price)
- Qty on hand + reorder point
- Stock status badge (IN STOCK / LOW / OUT OF STOCK)
- Admin can manually toggle **In Stock / Out of Stock** per product (button in the row)
- Remove the "+ Add Product" button — products are managed through QuickBooks, not the admin portal

Backend change needed:
- `PATCH /api/products/:id` already supports updating `quantity_on_hand` — just expose it in the UI
- Add a quick toggle endpoint or reuse the existing PATCH

#### 2. Customer Default Salmon Cut Preferences on Orders
When admin selects a customer in the New Order modal, auto-display that customer's salmon cut specs (cut type, skin off, scale, PBO H&G) as a read-only reference so the cutter knows what to do without opening a separate tab.
- No new backend needed — customer cut data already comes back on `GET /api/orders/:id`
- Frontend change: on customer dropdown change in New Order modal, fetch `GET /api/customers/:id` and show cut specs inline

#### 3. Packing Report — Split Salmon vs Non-Salmon
Separate the packing report into two sections:
- **Salmon** — any line item where product name/description contains the word "salmon" (case-insensitive). Show full cut specs: cut type, skin off, scale, PBO H&G.
- **Everything Else** — all other products. No cut columns.
Both sections still show: customer, qty, unit, notes.

#### 2. New Order Modal — 4 Default Item Rows
When the New Order modal opens, start with 4 empty item rows instead of 1. Saves the user from clicking "+ Add Item" repeatedly for typical orders.

#### 3. Orders Linked to Company, Not Individual User
Orders should be associated with a **company** (`customers.id`), not individual mobile users.
- Mobile users will have their own login credentials
- Multiple users can belong to the same company
- When a mobile user places an order, it links to their company's customer record
- Schema change needed: new `mobile_users` table with `customer_id → customers`

```sql
CREATE TABLE mobile_users (
  id SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

New auth routes needed:
- `POST /api/auth/customer-login` — returns JWT with `{ user_id, customer_id, company_name }`
- `GET /api/auth/me` — returns current user info

#### 4. Customer Signup + Admin Approval
Customers can request access from the mobile app. Admin approves or rejects.

Signup form fields: **company name, address, phone number** (enough for admin to verify it's a real fish reseller).

Backend changes:
- `POST /api/customers/request` — public endpoint, creates customer with `active = false`
- `GET /api/admin/pending` — returns customers where `active = false`
- `POST /api/admin/approve/:id` — sets `active = true`
- `POST /api/admin/reject/:id` — deletes the pending record

Admin UI changes:
- **Pending Approvals** section in sidebar with badge count
- Shows: company name, address, phone — Approve / Reject buttons

Schema addition needed on `customers`:
```sql
ALTER TABLE customers ADD COLUMN address TEXT;
```

---

## Phase 2 — Mobile App + Hosted Backend

### Testing Checklist

**Test 1 — Mobile app + local backend**
- [ ] Mobile app connects to `http://localhost:3001`
- [ ] All customers and products load correctly
- [ ] Customer can log in with their credentials
- [ ] Customer can browse products and place an order
- [ ] Order appears in admin portal
- [ ] QB invoice is generated

**Test 2 — Mobile app + Railway/Render hosted backend + QB Sandbox**
- [ ] Deploy backend to Railway/Render
- [ ] Set all env vars on the hosting platform
- [ ] Authorize QB OAuth on the hosted URL
- [ ] Mobile app points to hosted URL
- [ ] Full order flow works end-to-end
- [ ] Test invoice timing with full product/customer dataset

**Test 3 — Mobile app + hosted backend + Live QuickBooks**
- [ ] Switch `NODE_ENV=production` on the server
- [ ] Update `QB_REDIRECT_URI` to hosted domain
- [ ] Re-authorize with live QB company (SevenStarFoods)
- [ ] Confirm invoices appear in real QB

---

## Phase 3 — Production Features

#### QB Webhooks for Inventory Sync
When admin adds/edits a product in QuickBooks, it should automatically sync to the DB — no manual "Sync from QB" needed.
- Requires a public HTTPS URL (only works after deployment)
- Register webhook URL in QB developer portal
- Webhook handler already exists at `POST /api/webhooks/quickbooks`
- Add redirect URI and verifier token to env vars on hosted server

#### Invoice Generation Performance Test
Once all real customers and products are loaded:
- Time how long `POST /api/orders` takes end-to-end
- Time how long the QB invoice push takes
- If slow, consider batching or pre-fetching QB IDs at sync time instead of per-order

---

## Potential Issues to Watch

- **QB token expiry** — Refresh token lasts 100 days. If it expires, all QB pushes fail silently until re-authorized.
- **Failed QB invoice push** — Fire-and-forget. "Sync Pending to QB" button in admin UI handles retries after re-authorizing.
- **Customers without QB IDs** — Customers created through admin UI (not synced from QB) have no `qb_customer_id`. Their orders skip QB invoice push silently.
- **Webhooks require public URL** — Won't work on localhost. Defer until after deployment.
- **No HTTPS locally** — Mobile app and QB webhooks both need HTTPS in production.
- **Single admin account** — No UI to create more admins. Requires raw SQL.

---

## Command Reference

```bash
# Start server
cd backend && npm run dev

# Get JWT token
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type:application/json" \
  -d '{"username":"admin","password":"test123"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# Sync from QB
curl -X POST http://localhost:3001/api/admin/sync-from-qb \
  -H "Authorization:Bearer $TOKEN"

# Retry failed QB invoice pushes
curl -X POST http://localhost:3001/api/admin/sync-pending-invoices \
  -H "Authorization:Bearer $TOKEN"

# Clear all data + QB tokens
psql postgresql://localhost:5432/seven_stars_food -c \
  "DELETE FROM order_items; DELETE FROM orders; DELETE FROM products; DELETE FROM customers; DELETE FROM qb_tokens;"

# Check row counts
psql postgresql://localhost:5432/seven_stars_food -c \
  "SELECT COUNT(*) FROM products; SELECT COUNT(*) FROM customers; SELECT COUNT(*) FROM orders; SELECT COUNT(*) FROM qb_tokens;"
```

---

## Full Reset Flow
1. Clear all data (command above)
2. `Ctrl+C` → `npm run dev`
3. Open `http://localhost:3001/api/auth/qb` → authorize QB
4. Get token → run sync
5. Open `http://localhost:3001`

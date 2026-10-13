# Seven Stars Food — Ordering Backend

Backend and admin portal for a wholesale seafood distributor. Restaurants place orders from a mobile app, staff manage orders and inventory in a web portal, and every order becomes an invoice in QuickBooks Online, which remains the company's system of record for billing.

The system is in production use, deployed on Railway.

## What it does

- **Order intake** from two sources: the customer mobile app and manual entry by staff in the admin portal.
- **Two-way QuickBooks Online sync** for invoices, items (products) and customers.
- **Inventory** that follows QuickBooks quantities while reserving stock for orders that have not been invoiced yet.
- **Warehouse reports**: a packing report, a salmon pull report with each customer's cut preferences, and a daily pull export (PDF/Excel).
- **Customer accounts** with an approval flow: staff approve a new company, and that company's primary user approves its own additional users.

## Architecture

```
Mobile app (React Native) ─┐
                           ├─► Express API ──► PostgreSQL
Admin portal (static JS) ──┘        │  ▲
                                    ▼  │
                            QuickBooks Online
                     (OAuth2 · REST API · webhooks)
```

| Layer | Technology |
|---|---|
| Runtime | Node.js, Express |
| Database | PostgreSQL (`pg`), 18 forward-only SQL migrations |
| Accounting | QuickBooks Online via `intuit-oauth` and the QBO REST API |
| Auth | JWT, separate for staff and for mobile customers; bcrypt password hashes |
| Other | Cloudinary (product images), Brevo (password-reset email), `pdfkit` and `xlsx` (reports), `helmet`, `express-rate-limit` |

```
backend/
├── src/
│   ├── app.js           Entry point, scheduled jobs
│   ├── config/          Database pool, QuickBooks OAuth client, email
│   ├── routes/          Thin Express routers
│   ├── controllers/     Business logic
│   ├── middleware/      JWT auth, QuickBooks API helpers
│   ├── services/        Shared QuickBooks upsert logic, invoice-number counter
│   └── utils/
├── migrations/          001 → 018
├── scripts/             One-off maintenance and repair tools
└── public/index.html    Admin portal
```

The mobile app lives in a separate repository.

## Engineering highlights

### Keeping two systems consistent

QuickBooks does not guarantee webhook delivery, so each entity is kept in sync by three independent paths that share one upsert function:

1. **Webhooks** for near-real-time changes. The signature is verified with HMAC-SHA256, the handler answers `200` immediately, and processing happens afterwards.
2. **A reconciliation sweep every 20 minutes** that re-pulls recent invoices and item quantities and repairs anything a webhook missed.
3. **A manual full sync** for initial setup and on-demand checks.

Orders are pushed to QuickBooks asynchronously, so a QuickBooks outage never blocks a customer from ordering. Failed pushes are recorded on the order and retried.

### Invoice numbering under concurrency

This QuickBooks company uses custom transaction numbers, so QuickBooks does not assign invoice numbers itself. Reading the last number and adding one was racy when two orders arrived together. The fix was a PostgreSQL sequence as the single atomic source of the next number, with a retry when QuickBooks reports a duplicate (for example, when staff create an invoice by hand at the same moment) and a recovery action that moves the counter past QuickBooks' highest number.

### Preventing oversold stock

QuickBooks owns `quantity_on_hand`, but its updates arrive seconds to minutes late. The app keeps its own `reserved` count per product, so available stock is the QuickBooks quantity minus what pending orders have already claimed. Related safeguards:

- Product rows are always locked in ascending id order, which removes a deadlock between order placement and order editing.
- A per-order compare-and-set lock stops the background sweep and a user action from pushing the same order twice.
- Local stock is consumed at the moment an invoice is created, closing a window in which a second order could pass the stock check.

### Order editing with a clear ownership rule

Every order is tagged with its origin (`mobile`, `admin` or `qb`) when it is created. The origin decides who may edit it through the app; orders entered directly in QuickBooks are only edited there. Both edit endpoints call one shared function, so the mobile and admin paths cannot drift apart. QuickBooks-side corrections are still pulled in for every order, because the final weight and price of fish are only known after fulfilment.

### Security

- Separate JWT audiences for staff and customers, with role checks read from the database so a role change applies immediately.
- Server-authoritative pricing: prices sent by a client are ignored.
- Rate limiting across the API, with a tighter limit on password-reset endpoints; reset codes are stored hashed, expire after 15 minutes and lock after repeated failures.
- No secrets in the repository; all credentials come from environment variables.

## API overview

| Area | Examples |
|---|---|
| Auth | `POST /api/auth/login`, `POST /api/auth/customer-login`, `POST /api/auth/forgot-password` |
| Orders | `GET /api/orders?from=&to=`, `POST /api/orders`, `PATCH /api/orders/:id` |
| Products | `GET /api/products`, `PATCH /api/products/:id/out-of-stock` |
| Customers | `GET /api/customers`, `PATCH /api/customers/:id` |
| Mobile | `GET /api/mobile/products`, `POST /api/mobile/orders`, `PATCH /api/mobile/orders/:id` |
| Admin | `POST /api/admin/sync-from-qb`, `GET /api/admin/packing-report`, `POST /api/admin/invoice-number-recovery` |
| Webhooks | `POST /api/webhooks/quickbooks` |

## Running locally

Requires Node.js, PostgreSQL and a QuickBooks Online developer (sandbox) app.

```bash
cd backend
npm install

# create backend/.env with the variables listed below
createdb seven_stars_food
for f in migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done

npm run dev          # http://localhost:3001
```

Then create an admin user (a bcrypt hash in `admin_users`) and open `/api/auth/qb` in a browser to connect QuickBooks.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Signs staff and customer tokens |
| `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REDIRECT_URI` | QuickBooks OAuth app |
| `QB_WEBHOOK_VERIFIER_TOKEN` | Verifies webhook signatures |
| `BREVO_API_KEY`, `EMAIL_FROM` | Password-reset email (optional locally) |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Product images (optional) |
| `NODE_ENV`, `PORT` | `development` uses the QuickBooks sandbox |

Customer and pricing data files are deliberately not part of this repository.

## Team and my role

Built by a small team for a real business. I (Renpei Cai) designed and built the backend from the first commit: the schema and migrations, the QuickBooks integration, the order, inventory and concurrency logic, the authentication and approval flows, and much of the admin portal. Teammates built the mobile app and contributed product creation, reports and the password-reset flow on the backend.

## License

MIT — see [LICENSE](LICENSE).

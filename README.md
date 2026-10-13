# Seven Stars Food — Ordering System

An ordering system for Seven Stars Food, a wholesale seafood distributor. Restaurants order from a mobile app, staff run the day from a web admin page, and every order shows up in QuickBooks as an invoice without anyone retyping it.

## The three pieces

1. **The mobile app** — what customers (restaurants and other companies) use to browse products and place orders.
2. **The admin page** — what staff use to manage orders, customers, products and reports.
3. **QuickBooks Online** — where invoicing, inventory counts and accounting live. The system keeps itself in step with QuickBooks automatically, in both directions.

This repository holds the admin page and the server behind both it and the mobile app.

## Customers and accounts

- A **customer** is a company, not a person. Several people at the same company can each have their own login.
- **New companies need staff approval.** Someone signs up in the app with their company details, and the company waits in a pending list until staff approve it.
- **Joining an existing company** does not need staff. The company's main user (the first person who signed up) approves teammates from inside the app, and can remove them or hand the main-user role to someone else.
- Staff can also see every account grouped by company, delete accounts, choose a company's main user, and move a user to a different company.
- **Salmon preferences are asked once.** The first time a company logs in, it answers a short quiz about how it wants its salmon cut. The answers are saved and appear on the warehouse reports, so nobody has to ask again with each order.
- A customer who forgets their password can reset it with a 6-digit code sent by email.

## Orders

- Orders come in from the mobile app or are entered by staff. Prices always come from the current product list, never from something typed in at the time.
- **Two orders for the same delivery date become one.** A customer can keep adding to that day's order and it stays a single order and a single invoice.
- **Customers can change or cancel their own order** until the early morning of the delivery day. A cancelled order is kept and marked as voided, so there is still a record.
- **Staff can edit or delete orders** from the admin page.
- **Orders entered directly in QuickBooks** by a salesperson appear in the system too, but are only ever changed in QuickBooks.
- **Weights and prices can change after packing.** Fish is ordered by count, but the real weight is only known once the order is packed. When that final number is entered on the QuickBooks invoice, the system picks up the correction automatically.
- The admin page shows orders for today, the last 3 days, a week or a month. Orders are kept for 31 days.

## Products and stock

Each product mirrors an item in QuickBooks, with a few extra controls:

- **Market Price** — hides the price in the mobile app and shows "Market Price" instead, for items whose price moves daily. Staff always see the real number.
- **Out of Stock** — sets the quantity to zero in QuickBooks itself, so it is a firm "nothing left".
- **Availability override** — the opposite: marks an item as available even when the QuickBooks count looks like zero or is out of date. It stays on until someone turns it off, so overridden products sit at the top of the list with a badge.
- **Product photos** can be uploaded for the mobile app.

The quantity customers see is the QuickBooks count minus what other orders have already claimed. That stops two customers from both being promised the last box.

## Reports

- **Packing report** — for a delivery date, every product and how much each customer ordered.
- **Salmon pull report** — the same for salmon, with each customer's cut preferences alongside. Downloads to Excel.
- **Daily pull** — a printable PDF of the day's sales by customer, with a grand total.

## How the QuickBooks sync works

The sync runs in both directions, all the time:

- **System → QuickBooks.** Placing or editing an order creates or updates the matching invoice, normally within seconds. A customer who is new to QuickBooks is created there on their first order, with their address.
- **QuickBooks → system.** New customers, new or changed products, invoice corrections and voids made in QuickBooks flow back automatically, usually almost immediately.
- **A safety net every 20 minutes.** The system re-checks recent invoices and stock on its own, so nothing stays out of step for long even if a QuickBooks notification is missed.
- **Nothing is lost when QuickBooks is unreachable.** Customers can still order; the invoice is sent once QuickBooks is back.

Staff rarely need them, but the admin page has buttons to run a sync on demand, retry invoices that have not gone through, check for differences with QuickBooks, and fix invoice numbers.

## For developers

The server is Node.js with Express and PostgreSQL, and connects to QuickBooks Online. The mobile app is a separate React Native project.

```bash
cd backend
npm install
npm run dev
```

Before running, create `backend/.env` with the database address, a login secret and the QuickBooks app keys, and apply the files in `backend/migrations/` to the database in order. Customer and pricing data are deliberately not part of this repository.

## Credits

Built by a small team for Seven Stars Food. Renpei Cai built the server, the QuickBooks connection and much of the admin page; teammates built the mobile app and contributed product creation, reports and password reset.

## License

MIT — see [LICENSE](LICENSE).

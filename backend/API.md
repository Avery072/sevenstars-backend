# Seven Star Food — Mobile API Reference

Base URL: `https://sevenstars-backend-production.up.railway.app`

All protected endpoints require a `Bearer` token in the `Authorization` header.

---

## Authentication

### POST `/api/auth/customer-login`
Log in with email and password.

**No auth required.**

**Request body:**
```json
{
  "email": "user@example.com",
  "password": "yourpassword"
}
```

**Response `200`:**
```json
{
  "token": "<jwt>",
  "company_name": "ARIGATO",
  "name": "John Doe",
  "customer_id": 219
}
```

**Errors:**
- `401` — wrong email or password
- `403` — account pending admin approval (`{ "error": "Your account is pending admin approval" }`)

Store the `token` and attach it to every subsequent request:
```
Authorization: Bearer <token>
```

---

### POST `/api/auth/customer-signup`
Request a new account. Account is inactive until an admin approves it.

**No auth required.**

**Request body:**
```json
{
  "company_name": "My Restaurant",
  "first_name": "John",
  "last_name": "Doe",
  "email": "john@restaurant.com",
  "password": "yourpassword",
  "phone": "206-555-0000",
  "address": "123 Main St, Seattle WA"
}
```

**Response `201`:**
```json
{
  "message": "Signup request submitted. You will be notified once approved."
}
```

**Errors:**
- `409` — email already registered

---

### GET `/api/auth/customer-me`
Get current user info and company salmon cut preferences.

**Auth required.**

**Response `200`:**
```json
{
  "id": 1,
  "email": "john@restaurant.com",
  "name": "John Doe",
  "company_name": "ARIGATO",
  "customer_id": 219,
  "salmon_cut": "D-TRIM",
  "skin_off": false,
  "scale": true,
  "pbo": true,
  "hg": true,
  "language_pref": "English"
}
```

---

## Products

### GET `/api/mobile/products`
Get all active products. If `show_price` is `false`, the item is market-priced and `price` will be `null` — display "Market Price" instead of a number.

**Auth required.**

**Response `200`:**
```json
[
  {
    "id": 42,
    "sku": "SAL-ATL-12",
    "description": "Atlantic Salmon 12/14",
    "category": "Seafood - Fresh",
    "unit": "lb",
    "show_price": false,
    "price": null
  },
  {
    "id": 87,
    "sku": "OCT-001",
    "description": "Octopus Whole",
    "category": "Seafood - Fresh",
    "unit": "lb",
    "show_price": true,
    "price": "8.50"
  }
]
```

---

## Orders

### POST `/api/mobile/orders`
Place an order. Prices are always pulled from the database — do not send prices from the client.

**Auth required.**

**Request body:**
```json
{
  "delivery_date": "2026-05-28",
  "notes": "Please deliver before 9am",
  "items": [
    {
      "product_id": 42,
      "quantity": 10,
      "notes": "Extra fresh please"
    },
    {
      "product_id": 87,
      "quantity": 5
    }
  ]
}
```

**Fields:**
| Field | Required | Notes |
|---|---|---|
| `delivery_date` | Yes | `YYYY-MM-DD` format |
| `notes` | No | Order-level notes |
| `items` | Yes | Array, at least 1 item |
| `items[].product_id` | Yes | Must be an active product ID |
| `items[].quantity` | Yes | Must be ≥ 1 |
| `items[].notes` | No | Per-item notes |

**Response `201`:**
```json
{
  "message": "Order placed successfully",
  "order_id": 101
}
```

**Errors:**
- `400` — missing `delivery_date` or `items`
- `400` — product not found or inactive
- `400` — invalid quantity

---

## Profile / Cut Preferences

### PATCH `/api/mobile/profile`
Update salmon cut preferences for your company. This updates the **company-level** preference — all users at the same company will see the change.

**Auth required.**

**Request body** (all fields optional, send only what you want to change):
```json
{
  "salmon_cut": "D-TRIM",
  "skin_off": false,
  "scale": true,
  "pbo": true,
  "hg": false
}
```

**`salmon_cut` values:** `"D-TRIM"` · `"Half"` · `"Half-Cut"` · `"Bags"` · `null` (no preference)

**Response `200`:**
```json
{
  "id": 219,
  "salmon_cut": "D-TRIM",
  "skin_off": false,
  "scale": true,
  "pbo": true,
  "hg": false
}
```

---

## Common Patterns

### Auth header
```js
headers: {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${token}`
}
```

### Token expiry
Tokens expire after **8 hours**. When you get a `401` on a protected endpoint, the token has expired — redirect the user to login.

### Pending approval flow
After signup, the user cannot log in until an admin approves their account. On `403` at login, show a "pending approval" screen.

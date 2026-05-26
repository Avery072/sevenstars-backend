# Seven Star Food — Mobile + Backend Integration TODO

---

## ✅ Backend Ready (already built)
- [x] `POST /api/auth/customer-login` — email + password → JWT with customer_id + company_name
- [x] `POST /api/auth/customer-signup` — creates pending customer + mobile user (active = false)
- [x] `GET /api/auth/customer-me` — returns current user + company + salmon cut prefs
- [x] `GET /api/products` — returns all active products
- [x] `GET /api/customers/:id` — returns customer with cut prefs
- [x] `POST /api/orders` — creates order linked to customer_id
- [x] `GET /api/orders` — returns orders (need to filter by customer)
- [x] `mobile_users` table migration (`002_mobile_users.sql`)

---

## Phase 1 — Auth Flow

### 1. Run Migration
```bash
psql postgresql://localhost:5432/seven_stars_food -f backend/migrations/002_mobile_users.sql
```

### 2. Wire SignIn Screen to Backend
**File:** `screens/SignInScreen.js`
- Call `POST /api/auth/customer-login` with email + password
- On success: store JWT + company_name in AsyncStorage
- On `401`: show "Invalid email or password"
- On `403`: show "Your account is pending admin approval"
- On success: navigate to Homepage

```js
// Install first:
// npx expo install @react-native-async-storage/async-storage
import AsyncStorage from '@react-native-async-storage/async-storage';

const res = await fetch('http://YOUR_MAC_IP:3001/api/auth/customer-login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
});
const data = await res.json();
if (data.token) {
  await AsyncStorage.setItem('token', data.token);
  await AsyncStorage.setItem('company_name', data.company_name);
  navigation.navigate('Homepage');
}
```

### 3. Wire SignUp Screen to Backend
**File:** `screens/SignUp.js`
- Add **Address** and **Phone** fields (needed for admin approval review)
- Call `POST /api/auth/customer-signup`
- On success: show "Request submitted — pending admin approval" message
- Do NOT navigate to Homepage — they can't log in yet

Fields to send:
```json
{
  "company_name": "...",
  "first_name": "...",
  "last_name": "...",
  "email": "...",
  "password": "...",
  "address": "...",
  "phone": "..."
}
```

### 4. Admin — Pending Approvals Panel
**Files:** `backend/src/` (new routes) + `backend/public/index.html`

Backend needed:
- `GET /api/admin/pending` — customers where `active = false`
- `POST /api/admin/approve/:id` — sets customer + all their mobile_users to `active = true`
- `POST /api/admin/reject/:id` — deletes the pending customer + mobile_users

Admin UI needed:
- Sidebar item "Pending Approvals" with red badge count
- Table showing: company, address, phone, email, signup date
- Approve / Reject buttons per row

### 5. Set API Base URL
Find your Mac's IP and set a constant in the app:
```bash
ipconfig getifaddr en0
```
Create `screens/api.js`:
```js
export const API_URL = 'http://192.168.X.X:3001';
// Change to https://yourdomain.com when deployed
```

---

## Phase 2 — Product Browsing

### 6. Load Products from API
**File:** `screens/OrderScreen.js`
- Fetch `GET /api/products` on screen load using stored JWT
- Replace hardcoded salmon cards with real product data
- Show product name, SKU, price (or "Market Price" if `show_price = false`)
- Handle loading + empty states

### 7. Category Filter on Homepage
**File:** `screens/Homepage.js`
- Category circles (Salmon, Trout, etc.) should navigate to OrderScreen with a category filter param
- OrderScreen filters products by category or by name containing the category word
- Categories to support: Seafood - Fresh, Seafood - Frozen, Produce, Pantry

### 8. Product Card — Quantity + Unit
**File:** `screens/OrderScreen.js`
- Each card needs: +/− quantity control, unit selector (lb / ea / CA)
- Show unit from product data (`product.unit` as default)
- Price × qty preview if `show_price = true`

---

## Phase 3 — Cart + Checkout

### 9. Cart State (global)
- Use React Context or a simple global state to store cart items
- Cart item: `{ product_id, product_name, quantity, unit, unit_price }`
- "Add to Cart" button adds/updates item in cart
- Cart badge on bottom nav showing item count

### 10. Cart Screen (build from scratch)
New screen: `screens/CartScreen.js`
- List all cart items with qty controls (can edit here too)
- Remove item button
- Subtotal per item + order total
- "Review Order" button → goes to checkout review

### 11. Checkout Review Screen (build from scratch)
New screen: `screens/CheckoutScreen.js`
- Show: delivery date picker, order summary, notes field
- Display customer's salmon cut specs as a reminder (fetch from `GET /api/auth/customer-me`)
- "Confirm & Submit" button → calls `POST /api/orders`
- On success: show confirmation + clear cart + navigate to Homepage

Order payload:
```json
{
  "customer_id": "<from stored token>",
  "delivery_date": "YYYY-MM-DD",
  "notes": "...",
  "items": [
    { "product_id": 1, "quantity": 10, "unit": "lb", "unit_price": 22.50 }
  ]
}
```

---

## Phase 4 — Orders History (Invoice Tab)

### 12. Orders Screen
**File:** `screens/InvoiceScreen.js` (rename/repurpose Invoice tab)
- Fetch `GET /api/orders` filtered by the customer's `customer_id`
- **Backend change needed:** add `?customer_id=X` filter to `GET /api/orders`
- Show list of past orders: date, total, number of items
- Tap order → show order detail (line items)

---

## Phase 5 — Polish + UX

### 13. Auth Guard
- On app load, check AsyncStorage for token
- If token exists: navigate directly to Homepage (skip login)
- If expired/invalid: navigate to login
- Add logout button on profile/settings screen

### 14. Welcome Back on Homepage
- Replace hardcoded "Welcome back, John Doe" with real company name from AsyncStorage

### 15. Bottom Nav — Register Cart + Orders Screens
**File:** `screens/BottomNav.js` + `App.js`
- Add CartScreen and CheckoutScreen to stack navigator
- Wire Invoice tab to OrdersScreen
- Show cart item count badge on New Order tab

### 16. Error Handling + UX
- Loading spinners on all API calls
- Network error messages ("Cannot reach server")
- Pull-to-refresh on product and order lists
- Disabled submit button while request is in flight

---

## Backend Changes Still Needed

| Change | Route | Notes |
|---|---|---|
| Filter orders by customer | `GET /api/orders?customer_id=X` | Mobile users should only see their own orders |
| Pending approvals list | `GET /api/admin/pending` | Admin portal |
| Approve customer | `POST /api/admin/approve/:id` | Sets customer + mobile_users active = true |
| Reject customer | `POST /api/admin/reject/:id` | Deletes pending records |

---

## Install Checklist (mobile app)

```bash
cd Seven-Stars-App/OrderApp
npx expo install @react-native-async-storage/async-storage
npm install
npx expo start
```

Scan QR with Expo Go. Make sure phone + Mac are on same WiFi.


--                                                           
  Mobile App Bug Fix TODO                                            
                         
  Bug 1 — SignUp navigates to Homepage instead of showing "pending"  
  message                                                   
                                                                     
  File: screens/SignUp.js                                            
  - Wire form fields to state                                        
  - Call POST /api/auth/customer-signup on submit                    
  - On success: show Alert "Request submitted — admin will review    
  your account" then go back to SignIn                               
  - On error (duplicate email, etc): show error Alert                
  - Add Address + Phone fields (admin needs them to review) 
  - Do NOT navigate to Homepage                                      
                                                                     
  Bug 2 — "John Doe" is hardcoded                                    
                                                                     
  File: screens/Homepage.js                                          
  - Read company_name from AsyncStorage on load                      
  - Replace "Welcome back, John Doe" with real value                 
                                                            
  Bug 3 — BottomNav has broken nav targets                           
                                                                     
  File: screens/BottomNav.js                  
  - Cart → doesn't exist yet (future), point to OrderScreen for now  
  - Profile → doesn't exist yet, remove or disable for now         
                                                                     
  Bug 4 — Category circles navigate to unregistered screens 
                                                                     
  File: screens/Homepage.js                                 
  - Salmon, Octopus, Trout, etc. → all go to OrderScreen for now     
  (we'll add category filtering later)                          
                                                                     
  Bug 5 — Auth guard missing (anyone can skip login)        
                                                                     
  File: App.js                                              
  - On startup, check AsyncStorage for a token                       
  - If token exists → go to Homepage                                 
  - If not → go to Login screen
                                                                     
  ---                                                       
  Want me to fix all of these now?
                                                   
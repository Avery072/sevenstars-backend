-- QB OAuth tokens (one row per realm, refreshed as needed)
CREATE TABLE qb_tokens (
  id SERIAL PRIMARY KEY,
  realm_id TEXT UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Customers (mirrored from QB, extended with our fields)
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  qb_customer_id TEXT UNIQUE,
  company_name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  email TEXT,
  language_pref TEXT DEFAULT 'English',
  ordering_method TEXT DEFAULT 'Mobile App',
  salmon_cut TEXT,                  -- D-Trim, Half, Half-Cut, Bags, N/A
  skin_off BOOLEAN DEFAULT FALSE,
  scale BOOLEAN DEFAULT FALSE,
  pbo_hg BOOLEAN DEFAULT FALSE,
  notes TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Products (mirrored from QB Items, extended with show_price flag)
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  qb_item_id TEXT UNIQUE,
  sku TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT,                    -- 'Seafood - Fresh', 'Frozen', 'Produce', 'Pantry'
  unit TEXT NOT NULL,               -- lb, ea, CA
  cost NUMERIC(10,2),
  price NUMERIC(10,2),
  show_price BOOLEAN DEFAULT TRUE,  -- FALSE for market-price items like salmon
  quantity_on_hand NUMERIC(10,2) DEFAULT 0,
  reorder_point NUMERIC(10,2),
  vendor TEXT,
  active BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Orders (auto-purged after 3 days via scheduled cleanup)
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  qb_invoice_id TEXT UNIQUE,
  customer_id INT REFERENCES customers(id),
  delivery_date DATE NOT NULL,
  order_placed_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT,
  total NUMERIC(10,2)
);

-- Order line items
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id),
  quantity NUMERIC(10,2) NOT NULL,
  unit TEXT NOT NULL,
  unit_price NUMERIC(10,2),
  notes TEXT
);

-- Admin users
CREATE TABLE admin_users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

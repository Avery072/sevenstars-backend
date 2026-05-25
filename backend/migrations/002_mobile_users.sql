-- Mobile app users — multiple users can belong to the same customer (company)
CREATE TABLE mobile_users (
  id SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  active BOOLEAN DEFAULT FALSE,   -- FALSE until admin approves the company
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add address + phone to customers for signup approval review
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT;

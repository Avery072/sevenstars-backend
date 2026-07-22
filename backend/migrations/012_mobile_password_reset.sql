-- Forgot-password flow for mobile_users: email a 6-digit code, verify it, then
-- let the user set a new password. Code is stored hashed, like password_hash.
ALTER TABLE mobile_users ADD COLUMN IF NOT EXISTS reset_code_hash TEXT;
ALTER TABLE mobile_users ADD COLUMN IF NOT EXISTS reset_code_expires_at TIMESTAMPTZ;
ALTER TABLE mobile_users ADD COLUMN IF NOT EXISTS reset_code_attempts INT NOT NULL DEFAULT 0;

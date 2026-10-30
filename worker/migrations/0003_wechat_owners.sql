-- Requires configured AUTH_PASSWORD_PEPPER before password login can be enabled.
-- WeChat remains disabled until a reviewed website application and its secrets are configured.
-- Run once after 0001 and 0002. Legacy accounts keep owner_id NULL and remain inaccessible.
CREATE TABLE auth_users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'wechat' CHECK (provider IN ('wechat','password')),
  wechat_subject_hash TEXT UNIQUE,
  username TEXT UNIQUE,
  password_salt TEXT,
  password_hash TEXT,
  password_iterations INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE auth_login_transactions (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  code_challenge TEXT NOT NULL,
  wechat_app_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','ready','failed')),
  owner_id TEXT REFERENCES auth_users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_login_expiry ON auth_login_transactions(expires_at);
CREATE TABLE auth_oauth_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_code_expiry ON auth_oauth_codes(expires_at);
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES auth_users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_session_expiry ON auth_sessions(expires_at);
CREATE TABLE auth_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_rate_expiry ON auth_rate_limits(expires_at);
ALTER TABLE accounts ADD COLUMN owner_id TEXT REFERENCES auth_users(id);
CREATE INDEX accounts_owner_updated ON accounts(owner_id, updated_at DESC);

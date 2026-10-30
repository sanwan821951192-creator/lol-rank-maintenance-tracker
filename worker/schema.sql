CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'wechat' CHECK (provider IN ('wechat','password')),
  wechat_subject_hash TEXT UNIQUE,
  username TEXT UNIQUE,
  password_salt TEXT,
  password_hash TEXT,
  password_iterations INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_login_transactions (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  code_challenge TEXT NOT NULL,
  wechat_app_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','ready','failed')),
  owner_id TEXT REFERENCES auth_users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_login_expiry ON auth_login_transactions(expires_at);
CREATE TABLE IF NOT EXISTS auth_oauth_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_code_expiry ON auth_oauth_codes(expires_at);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES auth_users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_session_expiry ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_expiry ON auth_rate_limits(expires_at);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES auth_users(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  region TEXT NOT NULL CHECK (length(region) BETWEEN 1 AND 50),
  queue TEXT NOT NULL CHECK (queue IN ('单双排', '灵活组排', '未知')),
  tier TEXT NOT NULL CHECK (tier IN ('钻石', '大师及以上', '未知')),
  rank_tier TEXT CHECK (rank_tier IN ('IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER', 'UNRANKED')),
  rank_division TEXT CHECK (rank_division IN ('I', 'II', 'III', 'IV')),
  rank_lp INTEGER CHECK (rank_lp >= 0),
  profile_observed_at TEXT,
  days INTEGER NOT NULL CHECK (days BETWEEN 0 AND 365),
  baseline_date TEXT NOT NULL,
  baseline_at TEXT,
  note TEXT NOT NULL CHECK (length(note) <= 300),
  candidate_days INTEGER CHECK (candidate_days BETWEEN 0 AND 365),
  candidate_at TEXT,
  candidate_status TEXT CHECK (candidate_status IN ('estimate')),
  candidate_summary TEXT CHECK (length(candidate_summary) <= 2000),
  candidate_reviews TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS accounts_updated_at ON accounts(updated_at DESC);

CREATE INDEX IF NOT EXISTS accounts_owner_updated ON accounts(owner_id, updated_at DESC);

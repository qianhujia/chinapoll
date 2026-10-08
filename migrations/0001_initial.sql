CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  title TEXT,
  mode TEXT,
  start_at TEXT,
  end_at TEXT,
  status TEXT,
  proposal_ref TEXT
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  ip_bucket TEXT NOT NULL,
  option TEXT NOT NULL,
  ts_hour TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_issue_token
  ON votes(issue_id, token_hash);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  description TEXT,
  text_zh TEXT,
  text_en TEXT,
  token_hash TEXT,
  mode TEXT NOT NULL DEFAULT 'evergreen',
  start_at TEXT,
  end_at TEXT,
  status TEXT,
  clause TEXT,
  reviewed_at TEXT,
  published_issue INTEGER,
  poller_id TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comments_issue_created
  ON comments(issue_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS identities (
  poller_id TEXT PRIMARY KEY,
  email_hmac TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

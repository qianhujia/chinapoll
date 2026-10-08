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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_issue_token
  ON votes(issue_id, token_hash);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text_zh TEXT,
  text_en TEXT,
  token_hash TEXT,
  status TEXT,
  clause TEXT,
  reviewed_at TEXT,
  published_issue INTEGER,
  poller_id TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO issues (id, title, mode, start_at, end_at, status, proposal_ref)
VALUES (
  12,
  'Should the public adopt a unified yearly public-opinion snapshot mechanism?',
  'deadline',
  '2026-10-01T09:00:00Z',
  '2026-10-08T09:00:00Z',
  'open',
  NULL
);

-- One category per browser key. key_hash = SHA-256 of the secret key kept in the uploader's browser.
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  key_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS badges (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS badges_category ON badges(category_id);

CREATE TABLE IF NOT EXISTS images (
  badge_id TEXT NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (badge_id, key)
);

-- Upload log for per-IP rate limiting.
CREATE TABLE IF NOT EXISTS uploads (
  ip_hash TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_ip ON uploads(ip_hash, at);

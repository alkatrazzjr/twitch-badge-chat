-- People are identified by a secret key kept in their browser (key_hash = SHA-256 of it).
-- A user has one nick (unique by confusable skeleton) and any number of badge categories.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                 -- public id
  key_hash TEXT NOT NULL UNIQUE,
  nick TEXT NOT NULL,
  skeleton TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, name COLLATE NOCASE)
);
CREATE INDEX IF NOT EXISTS categories_owner ON categories(owner_id);

CREATE TABLE IF NOT EXISTS badges (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS badges_category ON badges(category_id);

CREATE TABLE IF NOT EXISTS images (
  badge_id TEXT NOT NULL REFERENCES badges(id),
  key TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (badge_id, key)
);

-- Rate limiting by IP (uploads, new categories).
CREATE TABLE IF NOT EXISTS events (
  ip_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ip ON events(ip_hash, kind, at);

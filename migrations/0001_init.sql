-- Your library: every film, diary entry, watchlist film, book, show, comic series and top-10 list
-- is one JSON document. "deleted" rows are kept briefly so other devices learn about deletions.
CREATE TABLE items (
  kind       TEXT NOT NULL,          -- film | watch | watchlist | book | show | series | top
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,          -- the JSON document
  updated_at INTEGER NOT NULL,       -- ms since epoch, set by the server
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, id)
);
CREATE INDEX items_updated ON items (updated_at);

-- Passkeys (one per device)
CREATE TABLE credentials (
  id          TEXT PRIMARY KEY,      -- credential ID (base64url)
  public_key  TEXT NOT NULL,         -- base64url
  counter     INTEGER NOT NULL DEFAULT 0,
  transports  TEXT,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,      -- SHA-256 of the cookie value
  credential  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- WebAuthn challenges and one-time "add a device" codes
CREATE TABLE challenges (
  id          TEXT PRIMARY KEY,
  challenge   TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE TABLE pair_codes (
  code        TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
);

-- Small settings store (job cursors, last backup, etc.)
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

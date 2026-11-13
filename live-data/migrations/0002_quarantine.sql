CREATE TABLE IF NOT EXISTS quarantined_feeds (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, captured_at INTEGER NOT NULL,
 reason TEXT NOT NULL, byte_length INTEGER NOT NULL, body BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS quarantine_time ON quarantined_feeds(captured_at DESC);

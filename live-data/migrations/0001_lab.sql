PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, pipeline TEXT NOT NULL, started_at INTEGER NOT NULL,
 finished_at INTEGER NOT NULL, status TEXT NOT NULL, source_ts INTEGER,
 input_rows INTEGER NOT NULL DEFAULT 0, accepted_rows INTEGER NOT NULL DEFAULT 0,
 rejected_rows INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_pipeline_time ON runs(pipeline, started_at DESC);
CREATE TABLE IF NOT EXISTS raw_feeds (
 hash TEXT PRIMARY KEY, kind TEXT NOT NULL, fetched_at INTEGER NOT NULL,
 source_ts INTEGER NOT NULL, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL,
 body BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_feed_time ON raw_feeds(fetched_at DESC);
CREATE TABLE IF NOT EXISTS snapshots (
 id TEXT PRIMARY KEY, source_ts INTEGER NOT NULL UNIQUE, fetched_at INTEGER NOT NULL,
 trip_hash TEXT NOT NULL, vehicle_hash TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX IF NOT EXISTS snapshot_source_time ON snapshots(source_ts DESC);
CREATE TABLE IF NOT EXISTS route_observations (
 snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
 route_key TEXT NOT NULL, route_id TEXT NOT NULL, direction INTEGER NOT NULL,
 source_ts INTEGER NOT NULL, n INTEGER NOT NULL, with_delay INTEGER NOT NULL,
 mean_delay REAL, median_delay REAL, p90_delay REAL,
 PRIMARY KEY(snapshot_id, route_key)
);
CREATE INDEX IF NOT EXISTS route_time ON route_observations(route_key, source_ts DESC);
CREATE TABLE IF NOT EXISTS predictions (
 snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
 route_key TEXT NOT NULL, issued_at INTEGER NOT NULL, target_at INTEGER NOT NULL,
 current_delay REAL NOT NULL, slope REAL NOT NULL, persistence REAL NOT NULL,
 candidate REAL NOT NULL, model_version TEXT NOT NULL,
 observed REAL, observed_at INTEGER, absolute_error_baseline REAL, absolute_error_candidate REAL,
 PRIMARY KEY(snapshot_id, route_key)
);
CREATE INDEX IF NOT EXISTS prediction_pending ON predictions(observed_at, target_at);
CREATE INDEX IF NOT EXISTS prediction_route ON predictions(route_key, issued_at DESC);
CREATE TABLE IF NOT EXISTS models (
 route_key TEXT PRIMARY KEY, trained_at INTEGER NOT NULL, version TEXT NOT NULL,
 intercept REAL NOT NULL, beta_current REAL NOT NULL, beta_slope REAL NOT NULL,
 train_n INTEGER NOT NULL, test_n INTEGER NOT NULL, test_mae REAL NOT NULL,
 baseline_mae REAL NOT NULL, test_start INTEGER NOT NULL, test_end INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seismic_snapshots (
 commit_sha TEXT PRIMARY KEY, generated_at INTEGER NOT NULL, imported_at INTEGER NOT NULL,
 metrics TEXT NOT NULL CHECK(json_valid(metrics)), counts TEXT NOT NULL CHECK(json_valid(counts)),
 quality TEXT NOT NULL CHECK(json_valid(quality))
);
CREATE INDEX IF NOT EXISTS seismic_time ON seismic_snapshots(generated_at DESC);
CREATE TABLE IF NOT EXISTS state (
 key TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value))
);

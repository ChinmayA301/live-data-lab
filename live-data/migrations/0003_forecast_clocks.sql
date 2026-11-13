-- Preserve initial development forecasts, but exclude them from the issue-clock
-- evaluation because their issue timestamps used the feed clock.
ALTER TABLE predictions ADD COLUMN feature_ts INTEGER;
CREATE INDEX IF NOT EXISTS prediction_feature_time ON predictions(feature_ts);

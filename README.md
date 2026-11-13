# Transit and seismic snapshots

A free GitHub Pages dashboard for understanding reported transit locations and schedule estimates, with a separate seismic report observatory. GitHub Actions attempts collection every 15 minutes; scheduling can be delayed. Observations have timestamps and delayed updates keep their original age.

The main view shows the map, available estimates and their coverage. Engineering diagnostics and model methodology are expandable. Snapshot publishing pauses ten-minute forecasts; the portable Node/SQLite collector is retained for a future always-on deployment.

Source extracted from the portfolio branch at https://github.com/ChinmayA301/ChinmayA301.github.io/tree/codex/live-data-observatories . Public upstream data: Metro Transit and the author's Live-Seismic-ML-Pipeline reports. Leaflet is vendored with its license; OpenStreetMap tiles retain attribution.

The publication job loads the last successful published JSON to retain up to 24 hours of observations without committing frequently changing data or keeping database artifacts. A failed deployment leaves the prior site intact. If previous JSON is unavailable, history can restart; this free edition is not a durable data archive. Full D1 history was exported separately for the future SQLite migration. No claim of uninterrupted collection, route reliability, or predictive improvement is made.

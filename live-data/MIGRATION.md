# Free snapshot hosting and portable migration

## Current free deployment

The public snapshot site is [Live Data Lab](https://app.chinmayarora.com/live-data-lab/), deployed from [ChinmayA301/live-data-lab](https://github.com/ChinmayA301/live-data-lab). Standard Ubuntu GitHub Actions builds verified snapshots and publishes GitHub Pages. Two successive initial publishes succeeded and preserved chart history; a scheduled run still needs observation before claiming the scheduler has fired.

The workflow requests collection at minutes 7, 22, 37 and 52 of each hour. GitHub can delay or drop scheduled runs and disables public-repository schedules after 60 days without repository activity. Check the repository Actions page if updates stop; re-enable the workflow if GitHub disabled it. No exact refresh guarantee is made. See [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Public-repository standard runners are free under [GitHub's billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions); Pages artifacts expire after one day. No paid service, larger runner or billing upgrade was enabled. This is a small public portfolio snapshot workflow, not an always-on server.

Each runner uses ephemeral SQLite. The previous published JSON carries up to 24 hours / 96 observations per route and accepted source timestamps into the next run. Missing or malformed upstream data cannot replace accepted observations. If neither current nor prior verified data exists, deployment fails and Pages retains the prior site. If prior JSON cannot be fetched but fresh sources validate, history can restart. This is not a durable archive. Raw replay and ten-minute forecast evaluation are not offered by this edition.

The dedicated repository is the deployment source. The portfolio contains the original implementation and the workflow template in `deployment/github-pages.yml`; synchronize shared assets/scripts to the dedicated repository when updating this implementation. The portfolio PR updates its links and embeds to the snapshot endpoint.

## Portable always-on edition

The lab's collector, API and static dashboards can run together on Node 24 with SQLite on persistent storage. The existing collector and SQL contracts are reused; the portable runtime does not call Cloudflare or D1. The same-origin HTML override removes the old API dependency only from pages served by this runtime. The source HTML points to the free snapshot site; the portable server overrides this to its own live API.

## Local execution

From `live-data`, run `npm ci`, `npm run build`, then `DB_PATH=/absolute/persistent/path/lab.sqlite npm start`. `COLLECTOR_ENABLED=false` starts an API-only inspection instance. `/healthz` checks process/database readiness; `/api/health` and feed timestamps distinguish readiness from successful fresh collection. The process runs collection once per minute, avoids overlapping cycles, and drains the active collection on shutdown.

The SQLite adapter applies checksum-tracked schema migrations, enables foreign keys/WAL, and commits batches without yielding midway through a transaction. Keep the database, WAL and shared-memory files on the same persistent filesystem. Never deploy this with the database on ephemeral application storage.

## Proposed Fly.io deployment

`fly.toml` proposes one 512 MiB shared-CPU Machine in `ord`, always running, with a volume named `lab_data` mounted at `/data`. This is a single-instance prototype and can have downtime during deployment or host failure; it is not a replicated/high-availability database. Automated backups to independent storage still need configuration before treating the deployment as durable production hosting. Do not scale to independent volumes without replication.

The Docker build context is the repository root. Suggested deployment command after account, app name, spending scope and persistent volume are confirmed:

```
flyctl deploy --config live-data/fly.toml --ha=false
```

No Fly resources have been provisioned. The installed Fly CLI has no authenticated session. The proposed app name has not been reserved. The Docker image has not been built locally because a Docker runtime is unavailable; the underlying Node runtime has been exercised directly.

## Cutover gates

1. Select and authenticate the destination account; confirm the hosting cost preference. Keep credentials out of chat and source files.
2. The D1 export has been imported and verified locally: integrity OK, zero foreign-key violations, matching row counts across all 11 source tables, and 10 sampled raw-feed hashes verified after decompression. In the local portfolio checkout, the ignored `live-data/storage/migration-2026-11-12/` directory contains `source.sql`, `lab.sqlite`, and `verification.json` with file hashes. This is a historical point-in-time backup, not current continuous history. Refresh it if later D1 data is needed. Do not overwrite an existing database.
3. Start the replacement on persistent storage. Verify independent scheduled source timestamps, both observatories, location maps, raw replay and forecast clocks at the replacement URL.
4. Configure/test backups and restoration. One attached volume alone is not a backup.
5. Update portfolio project links, source page API origins, and canonical URLs to the verified destination. Retain dated prior audit evidence as historical records.
6. Disable only this lab's Cloudflare cron after the replacement passes; preserve the old D1 database and configuration for rollback. Retire the old service only after the cutover is stable.

## Verification performed

23 domain/storage/runtime tests passed. Portable runtime tests verified persisted state after reopen, migration idempotency, transaction rollback and BLOB handling. Local HTTP checks verified readiness, same-origin dashboard HTML, empty API state, write rejection, HEAD behavior and path containment. GitHub Pages transit and seismic pages rendered real data. Transit route selection changed the map and metrics; the 390px mobile layout had no horizontal overflow. No browser errors were observed. Fly/GCP acceptance and Docker image execution remain pending; neither was provisioned.

## Cloudflare retirement status

The lab was redeployed with an empty cron list (version `acb5fe66-1b93-421b-a41a-33f3991a8e0b`). Legacy dashboard pages now fetch the GitHub Pages snapshots. D1 remains intact for rollback; no other Cloudflare service was changed. The existing custom domain still passes through Cloudflare DNS/proxy; collection, storage for the current snapshot edition, and Pages hosting have moved to GitHub.

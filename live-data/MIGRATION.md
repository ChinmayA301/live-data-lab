# Portable hosting migration (prepared, not cut over)

The lab's collector, API and static dashboards can run together on Node 24 with SQLite on persistent storage. The existing collector and SQL contracts are reused; the portable runtime does not call Cloudflare or D1. The same-origin HTML override removes the old API dependency only from pages served by this runtime. Existing portfolio links remain on the deployed origin until replacement hosting passes acceptance.

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
2. Export D1 history and verify a SQLite import, row counts, foreign keys, and sample raw-feed hashes. Do not overwrite an existing database. This remains pending until the source export is available and the import is validated.
3. Start the replacement on persistent storage. Verify independent scheduled source timestamps, both observatories, location maps, raw replay and forecast clocks at the replacement URL.
4. Configure/test backups and restoration. One attached volume alone is not a backup.
5. Update portfolio project links, source page API origins, and canonical URLs to the verified destination. Retain dated prior audit evidence as historical records.
6. Disable only this lab's Cloudflare cron after the replacement passes; preserve the old D1 database and configuration for rollback. Retire the old service only after the cutover is stable.

## Verification performed

22 existing/domain/storage/runtime tests passed. Portable runtime tests verified persisted state after reopen, migration idempotency, transaction rollback and BLOB handling. Local HTTP checks verified readiness, same-origin dashboard HTML, empty API state, write rejection, HEAD behavior and path containment. Fresh production acceptance remains pending destination access and cutover; this document does not claim migration is complete.

import { parseTransit, parseSeismic, predictionFor, fitTemporalModel, networkRollup, SEISMIC_REPO, HORIZON, MATCH_TOLERANCE,
  type TransitSnapshot, type FittedModel, type MaturedRow, type Prediction } from './domain.ts';

const TRANSIT = 'https://svc.metrotransit.org';
const RAW_LIMIT = 2 * 1024 * 1024;
const RAW_BUDGET = 64 * 1024 * 1024;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=15', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: JSON_HEADERS });
const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

class RetryableUpstreamError extends Error {}
export async function boundedFetch(url: string, limit = RAW_LIMIT, retry = false): Promise<Uint8Array> {
  const attempts = retry ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fetchAttempt(url, limit, 20_000 / attempts); }
    catch (error) {
      if (attempt + 1 === attempts || !(error instanceof RetryableUpstreamError || error instanceof TypeError
        || error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) throw error;
    }
  }
  throw new Error('Upstream attempts exhausted');
}
async function fetchAttempt(url: string, limit: number, timeout: number): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { 'User-Agent': 'ChinmayLiveDataLab/1.0 (+https://app.chinmayarora.com/)' }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    await response.body?.cancel();
    const message = `Upstream HTTP ${response.status}: ${new URL(url).hostname}`;
    if ([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(response.status)) throw new RetryableUpstreamError(message);
    throw new Error(message);
  }
  if (Number(response.headers.get('Content-Length')) > limit) { await response.body?.cancel(); throw new Error('Upstream payload exceeds size contract'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty upstream body');
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > limit) throw new Error('Upstream payload exceeds size contract'); chunks.push(value);
  } } catch (error) { await reader.cancel(); throw error; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
const getJson = async (url: string) => JSON.parse(new TextDecoder().decode(await boundedFetch(url)));
const getText = async (url: string) => new TextDecoder().decode(await boundedFetch(url));
async function state<T>(db: D1Database, key: string): Promise<T | null> {
  const result = await db.prepare('SELECT value FROM state WHERE key=?').bind(key).first<{ value: string }>();
  return result ? JSON.parse(result.value) as T : null;
}
async function putState(db: D1Database, key: string, value: unknown, now: number) {
  await db.prepare('INSERT INTO state(key,updated_at,value) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at,value=excluded.value').bind(key, now, JSON.stringify(value)).run();
}
async function compressed(bytes: Uint8Array): Promise<ArrayBuffer> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export async function storeTransit(db: D1Database, snapshot: TransitSnapshot, tripBytes: Uint8Array, vehicleBytes: Uint8Array, now: number, clock: () => number = Date.now) {
  const [tripHash, vehicleHash, tripGzip, vehicleGzip] = await Promise.all([sha256(tripBytes), sha256(vehicleBytes), compressed(tripBytes), compressed(vehicleBytes)]);
  const id = `${snapshot.source_ts}-${tripHash.slice(0, 16)}`;
  const previousState = await state<TransitSnapshot & { id: string }>(db, 'transit_latest');
  const raw = (kind: string, hash: string, sourceTs: number, body: ArrayBuffer) => db.prepare('INSERT OR IGNORE INTO raw_feeds(hash,kind,fetched_at,source_ts,sha256,byte_length,body) VALUES(?,?,?,?,?,?,?)').bind(`${kind}-${hash}`, kind, now, sourceTs, hash, body.byteLength, body);
  await db.batch([raw('tripupdates', tripHash, snapshot.source_ts, tripGzip), raw('vehiclepositions', vehicleHash, snapshot.vehicle_source_ts, vehicleGzip)]);
  if (previousState && snapshot.source_ts <= previousState.source_ts) {
    if (snapshot.source_ts === previousState.source_ts && id !== previousState.id) {
      const reason = 'Source revised a payload without advancing its timestamp; raw payload quarantined';
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO quarantined_feeds VALUES(?,?,?,?,?,?)').bind(`tripupdates-${tripHash}`, 'tripupdates', now, reason, tripGzip.byteLength, tripGzip),
        db.prepare('INSERT OR IGNORE INTO quarantined_feeds VALUES(?,?,?,?,?,?)').bind(`vehiclepositions-${vehicleHash}`, 'vehiclepositions', now, reason, vehicleGzip.byteLength, vehicleGzip)
      ]);
      throw new Error(reason);
    }
    return { duplicate: true, id };
  }
  const [oldRows, modelRows] = await Promise.all([
    db.prepare('SELECT route_key,source_ts,mean_delay FROM route_observations WHERE route_key IN (SELECT value FROM json_each(?)) AND source_ts BETWEEN ? AND ? AND with_delay>=2').bind(JSON.stringify([...snapshot.routes.map(r => r.route_key), 'all']), snapshot.source_ts - 8 * 60_000, snapshot.source_ts - 120_000).all<{ route_key: string; source_ts: number; mean_delay: number }>(),
    db.prepare('SELECT * FROM models').all<FittedModel>()
  ]);
  const previous = new Map<string, { source_ts: number; mean_delay: number }>();
  for (const row of oldRows.results) {
    const current = previous.get(row.route_key);
    if (!current || Math.abs(row.source_ts - (snapshot.source_ts - 3 * 60_000)) < Math.abs(current.source_ts - (snapshot.source_ts - 3 * 60_000))) previous.set(row.route_key, row);
  }
  const models = new Map(modelRows.results.map(m => [m.route_key, m]));
  const observationRoutes = [...snapshot.routes, networkRollup(snapshot.routes)];
  const issuedAt = clock();
  const predictions = observationRoutes.map(route => predictionFor(route, snapshot.source_ts, previous.get(route.route_key), models.get(route.route_key), issuedAt)).filter((p): p is Prediction => p !== null);
  const payload = JSON.stringify({ ...snapshot, id });
  await db.batch([
    db.prepare('INSERT INTO snapshots(id,source_ts,fetched_at,trip_hash,vehicle_hash,payload) VALUES(?,?,?,?,?,?)').bind(id, snapshot.source_ts, now, tripHash, vehicleHash, payload),
    db.prepare(`INSERT INTO route_observations(snapshot_id,route_key,route_id,direction,source_ts,n,with_delay,mean_delay,median_delay,p90_delay)
      SELECT ?,json_extract(value,'$.route_key'),json_extract(value,'$.route_id'),json_extract(value,'$.direction'),?,json_extract(value,'$.n'),json_extract(value,'$.with_delay'),json_extract(value,'$.mean_delay'),json_extract(value,'$.median_delay'),json_extract(value,'$.p90_delay') FROM json_each(?)`).bind(id, snapshot.source_ts, JSON.stringify(observationRoutes)),
    db.prepare(`INSERT INTO predictions(snapshot_id,route_key,feature_ts,issued_at,target_at,current_delay,slope,persistence,candidate,model_version)
      SELECT ?,json_extract(value,'$.route_key'),json_extract(value,'$.feature_ts'),json_extract(value,'$.issued_at'),json_extract(value,'$.target_at'),json_extract(value,'$.current_delay'),json_extract(value,'$.slope'),json_extract(value,'$.persistence'),json_extract(value,'$.candidate'),json_extract(value,'$.model_version') FROM json_each(?)`).bind(id, JSON.stringify(predictions)),
    db.prepare('INSERT INTO state(key,updated_at,value) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at,value=excluded.value').bind('transit_latest', now, payload)
  ]);
  await settlePredictions(db, snapshot.source_ts);
  return { duplicate: false, id };
}

export async function settlePredictions(db: D1Database, sourceTs: number) {
  const settled = await db.prepare(`UPDATE predictions SET
    observed=(SELECT o.mean_delay FROM route_observations o WHERE o.route_key=predictions.route_key AND o.with_delay>=2 AND o.source_ts BETWEEN predictions.target_at AND predictions.target_at+? ORDER BY o.source_ts LIMIT 1),
    observed_at=(SELECT o.source_ts FROM route_observations o WHERE o.route_key=predictions.route_key AND o.with_delay>=2 AND o.source_ts BETWEEN predictions.target_at AND predictions.target_at+? ORDER BY o.source_ts LIMIT 1)
    WHERE observed_at IS NULL AND feature_ts IS NOT NULL AND target_at BETWEEN ? AND ? RETURNING snapshot_id,route_key,observed_at`).bind(MATCH_TOLERANCE, MATCH_TOLERANCE, sourceTs - 15 * 60_000, sourceTs).all<{snapshot_id:string;route_key:string;observed_at:number|null}>();
  const matched = settled.results.filter(r => r.observed_at !== null);
  if (matched.length) await db.prepare("UPDATE predictions SET absolute_error_baseline=abs(observed-persistence),absolute_error_candidate=abs(observed-candidate) WHERE (snapshot_id,route_key) IN (SELECT json_extract(value,'$.snapshot_id'),json_extract(value,'$.route_key') FROM json_each(?))").bind(JSON.stringify(matched)).run();
}

async function collectTransit(db: D1Database, now: number) {
  let labels = await state<{ fetched_at: number; labels: Record<string, string> }>(db, 'route_labels');
  if (!labels || now - labels.fetched_at > 24 * 3600_000) {
    const routes = await getJson(`${TRANSIT}/nextrip/routes`);
    if (!Array.isArray(routes) || !routes.length || routes.some(r => typeof r.route_id !== 'string' || typeof r.route_label !== 'string')) throw new Error('Route metadata schema changed');
    labels = { fetched_at: now, labels: Object.fromEntries(routes.map(r => [r.route_id, r.route_label])) };
    await putState(db, 'route_labels', labels, now);
  }
  const [trips, positions] = await Promise.all([boundedFetch(`${TRANSIT}/mtgtfs/tripupdates.pb`, RAW_LIMIT, true), boundedFetch(`${TRANSIT}/mtgtfs/vehiclepositions.pb`, RAW_LIMIT, true)]);
  const fetchedAt = Date.now();
  let snapshot: TransitSnapshot;
  try { snapshot = parseTransit(trips, positions, labels.labels, fetchedAt); }
  catch (error) {
    const reason = error instanceof Error ? error.message : 'Feed decoding failed';
    for (const [kind, bytes] of [['tripupdates', trips], ['vehiclepositions', positions]] as const) {
      const hash = await sha256(bytes), body = await compressed(bytes);
      await db.prepare('INSERT OR IGNORE INTO quarantined_feeds(id,kind,captured_at,reason,byte_length,body) VALUES(?,?,?,?,?,?)').bind(`${kind}-${hash}`, kind, now, reason, body.byteLength, body).run();
    }
    throw error;
  }
  const stored = await storeTransit(db, snapshot, trips, positions, fetchedAt);
  return { source_ts: snapshot.source_ts, input: snapshot.input_trips + snapshot.input_positions,
    accepted: snapshot.routes.reduce((n, r) => n + r.n, 0) + snapshot.positions.length,
    rejected: snapshot.invalid_trips + snapshot.duplicate_trips + snapshot.invalid_positions,
    message: stored.duplicate ? 'Repeated or older source timestamp; kept last accepted snapshot' : `${snapshot.routes.length} route-directions; ${snapshot.missing_delay} trips without usable delay; ${snapshot.cancelled_trips} cancellations; ${snapshot.positions.length} valid locations; ${snapshot.invalid_positions} excluded vehicle records; ${snapshot.position_quality?.duplicate_entity_ids ?? 0} repeated vehicle entity IDs` };
}

type CommitEntry = { sha: string; commit: { committer: { date: string } } };
async function collectSeismic(db: D1Database, now: number) {
  const latest = await db.prepare('SELECT commit_sha FROM seismic_snapshots ORDER BY generated_at DESC LIMIT 1').first<{ commit_sha: string }>();
  const commits = await getJson(`https://api.github.com/repos/${SEISMIC_REPO}/commits?path=reports/_metrics.json&per_page=${latest ? 1 : 12}`) as CommitEntry[];
  if (!Array.isArray(commits) || !commits.length || !commits.every(c => /^[a-f0-9]{40}$/.test(c.sha))) throw new Error('Invalid upstream revision list');
  let imported = 0;
  const skipped: string[] = [];
  for (const commit of commits) {
    if (await db.prepare('SELECT 1 AS present FROM seismic_snapshots WHERE commit_sha=?').bind(commit.sha).first()) continue;
    try {
    const base = `https://raw.githubusercontent.com/${SEISMIC_REPO}/${commit.sha}/reports`;
    const [metrics, statusText, quality] = await Promise.all([getJson(`${base}/_metrics.json`), getText(`${base}/STATUS.md`), getText(`${base}/data_quality_report.md`)]);
    const record = parseSeismic(metrics, statusText, quality);
    if (record.generated_at > now + 60_000) throw new Error('Upstream report has a future timestamp');
    await db.prepare('INSERT INTO seismic_snapshots(commit_sha,generated_at,imported_at,metrics,counts,quality) VALUES(?,?,?,?,?,?)').bind(commit.sha, record.generated_at, now, JSON.stringify(record.metrics), JSON.stringify(record.counts), JSON.stringify(record.quality)).run(); imported++;
    } catch (error) {
      if (commit.sha === commits[0].sha) throw error;
      skipped.push(commit.sha);
      console.warn(JSON.stringify({ event: 'historical_report_unavailable', sha: commit.sha, reason: error instanceof Error ? error.message : 'Unknown' }));
    }
  }
  const workflows = await getJson(`https://api.github.com/repos/${SEISMIC_REPO}/actions/workflows/pipeline.yml/runs?per_page=8`);
  if (!Array.isArray(workflows.workflow_runs)) throw new Error('Invalid workflow response');
  await putState(db, 'seismic_workflows', workflows.workflow_runs.map((r: { id: number; status: string; conclusion: string | null; run_started_at: string; updated_at: string; html_url: string; head_sha: string }) => ({ id: r.id, status: r.status, conclusion: r.conclusion, started_at: r.run_started_at, updated_at: r.updated_at, url: r.html_url, sha: r.head_sha })), now);
  const record = await db.prepare('SELECT generated_at FROM seismic_snapshots ORDER BY generated_at DESC LIMIT 1').first<{ generated_at: number }>();
  return { source_ts: record?.generated_at || null, input: commits.length, accepted: imported, rejected: skipped.length, message: `${imported} new verified report revisions; ${skipped.length} historical revisions unavailable; aggregate metrics only` };
}

export async function trainModels(db: D1Database, now: number) {
  // Bound model-fitting memory: the network plus up to fifteen recently active
  // route-directions, each with at most 180 matured records from the last day.
  const rows = await db.prepare(`WITH active AS (
    SELECT route_key FROM route_observations
    WHERE snapshot_id=(SELECT id FROM snapshots ORDER BY source_ts DESC LIMIT 1)
    ORDER BY CASE WHEN route_key='all' THEN 0 ELSE 1 END,with_delay DESC,route_key LIMIT 16
  ), ranked AS (
    SELECT p.route_key,p.issued_at,p.target_at,p.observed_at,p.current_delay,p.slope,p.observed,
      ROW_NUMBER() OVER (PARTITION BY p.route_key ORDER BY p.issued_at DESC) AS rownum
    FROM predictions p JOIN active a ON a.route_key=p.route_key
    WHERE p.observed_at IS NOT NULL AND p.feature_ts IS NOT NULL AND p.issued_at>?
  ) SELECT route_key,issued_at,target_at,observed_at,current_delay,slope,observed FROM ranked
    WHERE rownum<=180 ORDER BY issued_at LIMIT 2880`).bind(now - 24 * 3600_000).all<MaturedRow & { route_key: string }>();
  const grouped = new Map<string, MaturedRow[]>();
  for (const row of rows.results) { const group = grouped.get(row.route_key) || []; group.push(row); grouped.set(row.route_key, group); }
  const fitted = [...grouped.entries()].map(([key, group]) => fitTemporalModel(key, group, now)).filter((m): m is FittedModel => m !== null);
  if (fitted.length) await db.prepare(`INSERT INTO models(route_key,trained_at,version,intercept,beta_current,beta_slope,train_n,test_n,test_mae,baseline_mae,test_start,test_end)
    SELECT json_extract(value,'$.route_key'),json_extract(value,'$.trained_at'),json_extract(value,'$.version'),json_extract(value,'$.intercept'),json_extract(value,'$.beta_current'),json_extract(value,'$.beta_slope'),json_extract(value,'$.train_n'),json_extract(value,'$.test_n'),json_extract(value,'$.test_mae'),json_extract(value,'$.baseline_mae'),json_extract(value,'$.test_start'),json_extract(value,'$.test_end') FROM json_each(?) WHERE true
    ON CONFLICT(route_key) DO UPDATE SET trained_at=excluded.trained_at,version=excluded.version,intercept=excluded.intercept,beta_current=excluded.beta_current,beta_slope=excluded.beta_slope,train_n=excluded.train_n,test_n=excluded.test_n,test_mae=excluded.test_mae,baseline_mae=excluded.baseline_mae,test_start=excluded.test_start,test_end=excluded.test_end`).bind(JSON.stringify(fitted)).run();
  await putState(db, 'model_training', { trained_at: now, eligible_routes: fitted.length, minimum_matured_samples: 80, maximum_route_groups: 16, maximum_records_per_group: 180, horizon_minutes: 10, training_labels_before_test: true }, now);
}
async function runPipeline(db: D1Database, pipeline: string, now: number, fn: () => Promise<{source_ts: number | null; input: number; accepted: number; rejected: number; message: string}>) {
  const id = crypto.randomUUID();
  try {
    const r = await fn();
    await db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id, pipeline, now, Date.now(), 'success', r.source_ts, r.input, r.accepted, r.rejected, r.message).run();
    console.log(JSON.stringify({ event: 'collection', pipeline, status: 'success', ...r }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown collection failure';
    await db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id, pipeline, now, Date.now(), 'failed', null, 0, 0, 0, message).run();
    console.error(JSON.stringify({ event: 'collection', pipeline, status: 'failed', message }));
  }
}

export async function collect(env: Env, now = Date.now()) {
  const lease = crypto.randomUUID();
  const lock = await env.DB.prepare('INSERT INTO leases(name,token,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE leases.expires_at<?').bind('collector', lease, now + 55_000, now).run();
  if (!lock.meta.changes) return;
  try {
    await runPipeline(env.DB, 'transit', now, () => collectTransit(env.DB, now));
    const lastSeismic = await env.DB.prepare("SELECT MAX(started_at) AS t FROM runs WHERE pipeline='seismic'").first<{t:number|null}>();
    if (!lastSeismic?.t || now - lastSeismic.t >= 15 * 60_000) await runPipeline(env.DB, 'seismic', now, () => collectSeismic(env.DB, now));
    const training = await state<{ trained_at: number }>(env.DB, 'model_training');
    if (!training || now - training.trained_at >= 30 * 60_000) await trainModels(env.DB, Date.now());
    const cleanup = await state<{ at: number }>(env.DB, 'cleanup');
    if (!cleanup || now - cleanup.at >= 3600_000) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM raw_feeds WHERE hash IN (SELECT hash FROM (SELECT hash,fetched_at,SUM(byte_length) OVER (ORDER BY fetched_at DESC,hash) AS running_bytes FROM raw_feeds) WHERE running_bytes>? OR fetched_at<?)').bind(RAW_BUDGET, now - 6 * 3600_000),
        env.DB.prepare('DELETE FROM snapshots WHERE source_ts<?').bind(now - 7 * 86400_000),
        env.DB.prepare("UPDATE snapshots SET payload='{}' WHERE source_ts<? AND payload<>'{}'").bind(now - 6 * 3600_000),
        env.DB.prepare('DELETE FROM quarantined_feeds WHERE id IN (SELECT id FROM (SELECT id,captured_at,SUM(byte_length) OVER (ORDER BY captured_at DESC,id) AS running_bytes FROM quarantined_feeds) WHERE running_bytes>? OR captured_at<?)').bind(16 * 1024 * 1024, now - 6 * 3600_000),
        env.DB.prepare('DELETE FROM runs WHERE started_at<?').bind(now - 30 * 86400_000)
      ]);
      await putState(env.DB, 'cleanup', { at: now }, now);
    }
  } finally { await env.DB.prepare('DELETE FROM leases WHERE name=? AND token=?').bind('collector', lease).run(); }
}

async function transitResponse(db: D1Database, url: URL) {
  const selected = url.searchParams.get('route') || 'all';
  if (selected !== 'all' && !/^[A-Za-z0-9_-]{1,30}\|-?\d$/.test(selected)) return json({ error: 'Invalid route selector' }, 400);
  if (url.searchParams.has('window') && !['6h','24h'].includes(url.searchParams.get('window')!)) return json({ error: 'Invalid history window' }, 400);
  const hours = url.searchParams.get('window') === '24h' ? 24 : 6, now = Date.now();
  const latest = await state<TransitSnapshot & { id: string }>(db, 'transit_latest');
  if (!latest) return json({ available: false, message: 'Waiting for the first accepted feed snapshot', server_time: now });
  const [history, evaluation, models, runs, archive, training, forecasts] = await Promise.all([
    db.prepare(`SELECT CAST(source_ts/120000 AS INTEGER)*120000 AS t,
      SUM(mean_delay*with_delay)/SUM(with_delay) AS delay_seconds,SUM(with_delay) AS trips,
      COUNT(DISTINCT route_key) AS route_directions FROM route_observations
      WHERE source_ts>? AND route_key=? AND with_delay>0 GROUP BY t ORDER BY t`).bind(now - hours * 3600_000, selected).all(),
    db.prepare(`SELECT model_version,COUNT(*) AS n,AVG(absolute_error_baseline) AS baseline_mae,AVG(absolute_error_candidate) AS candidate_mae,MIN(issued_at) AS first_issued,MAX(observed_at) AS last_outcome FROM predictions WHERE observed_at IS NOT NULL AND feature_ts IS NOT NULL AND issued_at>? AND route_key=? GROUP BY model_version ORDER BY last_outcome DESC LIMIT 12`).bind(now - 24 * 3600_000, selected).all(),
    db.prepare('SELECT * FROM models WHERE route_key=? ORDER BY trained_at DESC LIMIT 30').bind(selected).all(),
    db.prepare("SELECT * FROM runs WHERE pipeline='transit' ORDER BY started_at DESC LIMIT 12").all(),
    db.prepare('SELECT COUNT(*) AS snapshots,COALESCE(SUM(byte_length),0) AS bytes,MIN(fetched_at) AS oldest_at,MAX(fetched_at) AS newest_at FROM raw_feeds').first(),
    state(db, 'model_training'),
    db.prepare('SELECT * FROM predictions WHERE snapshot_id=? AND route_key=? AND feature_ts IS NOT NULL ORDER BY route_key').bind(latest.id, selected).all()
  ]);
  return json({ available: true, server_time: now, selected, window_hours: hours,
    source: { url: `${TRANSIT}/`, provider_refresh_seconds: 5, collector_interval_seconds: 60, stale_after_seconds: 180, source_is: 'Published delay estimates and vehicle positions; not verified actual arrivals' },
    latest, history: history.results, evaluation: evaluation.results, models: models.results,
    runs: runs.results, archive, training, forecasts: forecasts.results });
}

export default {
  async scheduled(_event, env, ctx) { ctx.waitUntil(collect(env)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...JSON_HEADERS, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' } });
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Read-only API' }, 405);
    try {
      if (url.pathname === '/api/transit') {
        const cache = typeof caches !== 'undefined' ? caches.default : undefined;
        const cacheKey = new Request(url.origin + url.pathname + '?route=' + encodeURIComponent(url.searchParams.get('route') || 'all') + '&window=' + encodeURIComponent(url.searchParams.get('window') || '6h'));
        const cached = await cache?.match(cacheKey);
        if (cached) return cached;
        const response = await transitResponse(env.DB, url);
        if (cache && response.ok && ctx) ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }
      if (url.pathname === '/api/transit/raw') {
        const kind = url.searchParams.get('kind'), id = url.searchParams.get('snapshot') || '';
        if (!['tripupdates','vehiclepositions'].includes(kind || '') || !/^\d{13}-[a-f0-9]{16}$/.test(id)) return json({ error: 'Invalid replay selector' }, 400);
        const hashColumn = kind === 'tripupdates' ? 'trip_hash' : 'vehicle_hash';
        // Only fixed, allowlisted SQL identifiers are interpolated. Values remain bound parameters.
        const row = await env.DB.prepare(`SELECT r.body,r.sha256 FROM raw_feeds r JOIN snapshots s ON r.sha256=s.${hashColumn} WHERE s.id=? AND r.kind=?`).bind(id, kind).first<{ body: ArrayBuffer | number[]; sha256: string }>();
        if (!row) return json({ error: 'Raw snapshot is outside the retained replay window' }, 404);
        const bytes = Array.isArray(row.body) ? new Uint8Array(row.body) : new Uint8Array(row.body);
        return new Response(bytes, { encodeBody: 'manual', headers: { ...JSON_HEADERS, 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=3600', 'X-Content-SHA256': row.sha256 } });
      }
      if (url.pathname === '/api/seismic') {
        const [snapshots, workflows, runs] = await Promise.all([
          env.DB.prepare('SELECT * FROM seismic_snapshots ORDER BY generated_at DESC LIMIT 30').all<{ commit_sha: string; generated_at: number; imported_at: number; metrics: string; counts: string; quality: string }>(),
          state(env.DB, 'seismic_workflows'), env.DB.prepare("SELECT * FROM runs WHERE pipeline='seismic' ORDER BY started_at DESC LIMIT 8").all()
        ]);
        return json({ available: snapshots.results.length > 0, server_time: Date.now(), repository: `https://github.com/${SEISMIC_REPO}`, upstream_cadence_hours: 6, import_interval_minutes: 15,
          snapshots: snapshots.results.map(s => ({ ...s, metrics: JSON.parse(s.metrics), counts: JSON.parse(s.counts), quality: JSON.parse(s.quality) })),
          workflows, runs: runs.results, unavailable: ['Event-level scored data are not exported by the upstream repository.', 'A machine-readable drift series is not exported; no drift history is inferred from README text.'] });
      }
      if (url.pathname === '/api/health') {
        const runs = await env.DB.prepare('SELECT pipeline,MAX(started_at) AS latest_attempt FROM runs GROUP BY pipeline').all();
        return json({ service: 'Chinmay Live Data Lab', server_time: Date.now(), pipelines: runs.results });
      }
      return json({ error: 'Unknown API route' }, 404);
    } catch (error) {
      console.error(JSON.stringify({ event: 'api_failure', path: url.pathname, message: error instanceof Error ? error.message : 'Unknown' }));
      const quota = error instanceof Error && /(?:row read limit|daily.*limit|D1.*quota)/i.test(error.message);
      return json({ error: quota ? 'The database daily read allowance is exhausted. Collection resumes after the midnight UTC quota reset.' : 'Stored data are temporarily unavailable. The client should retain its last accepted snapshot.' }, 503);
    }
  }
} satisfies ExportedHandler<Env>;

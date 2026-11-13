import gtfs from 'gtfs-realtime-bindings';

export const HORIZON = 10 * 60_000;
export const MATCH_TOLERANCE = 90_000;
export const MAX_FEED_AGE = 180_000;
export const SEISMIC_REPO = 'ChinmayA301/Live-Seismic-ML-Pipeline';
const owns = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
export type RouteRow = { route_key: string; route_id: string; direction: number; label: string; n: number; with_delay: number; mean_delay: number | null; median_delay: number | null; p90_delay: number | null };
export type Position = { route_key: string; route_id: string; vehicle_id: string; lat: number; lon: number; observed_at: number };
export type PositionQuality = { duplicate_entity_ids: number; invalid_records: number; duplicate_records: number; conflicting_records: number };
export type TransitSnapshot = { source_ts: number; vehicle_source_ts: number; fetched_at: number; routes: RouteRow[]; positions: Position[]; input_trips: number; cancelled_trips: number; duplicate_trips: number; invalid_trips: number; missing_delay: number; input_positions: number; invalid_positions: number; position_quality?: PositionQuality };
export function networkRollup(routes: RouteRow[]): RouteRow {
  const n = routes.reduce((sum, row) => sum + row.n, 0), covered = routes.reduce((sum, row) => sum + row.with_delay, 0);
  return { route_key: 'all', route_id: 'all', direction: -1, label: 'All reporting route-directions', n,
    with_delay: covered, mean_delay: covered ? routes.reduce((sum, row) => sum + (row.mean_delay ?? 0) * row.with_delay, 0) / covered : null,
    median_delay: null, p90_delay: null };
}

function checkedFeed(bytes: Uint8Array, now: number, strictEntityIds = true) {
  const message = gtfs.transit_realtime.FeedMessage.decode(bytes);
  const ts = Number(message.header.timestamp) * 1000;
  if (!Number.isFinite(ts) || ts < 946684800000 || ts > now + 30_000) throw new Error('Invalid or future source timestamp');
  if (now - ts > MAX_FEED_AGE) throw new Error(`Stale source feed (${Math.round((now - ts) / 1000)} seconds old)`);
  if (message.header.incrementality !== 0) throw new Error('Differential feeds require a separate state merger');
  const ids = message.entity.map(e => e.id);
  if (strictEntityIds && new Set(ids).size !== ids.length) throw new Error('Duplicate feed entity identifiers');
  return { message, ts };
}

export function parseTransit(tripsBytes: Uint8Array, vehiclesBytes: Uint8Array, labels: Record<string, string>, now: number): TransitSnapshot {
  // Metro Transit sometimes reuses a vehicle entity ID for an untimestamped
  // (0,0) schedule placeholder and a real observation. Validate rows before
  // resolving vehicle identities; retain the raw source and report anomalies.
  const trips = checkedFeed(tripsBytes, now), vehicles = checkedFeed(vehiclesBytes, now, false);
  const grouped = new Map<string, { route_id: string; direction: number; n: number; delays: number[] }>();
  const seenTrips = new Set<string>();
  let cancelled = 0, duplicate = 0, invalid = 0, missing = 0;
  for (const entity of trips.message.entity) {
    const update = entity.tripUpdate, trip = update?.trip;
    if (!update || !trip?.tripId || !trip.routeId || !trip.startDate || entity.isDeleted) { invalid++; continue; }
    if (Number(trip.scheduleRelationship) === 3 || Number(trip.scheduleRelationship) === 7) { cancelled++; continue; }
    const identity = `${trip.startDate}|${trip.startTime || ''}|${trip.tripId}`;
    if (seenTrips.has(identity)) { duplicate++; continue; }
    if (owns(update, 'timestamp') && (Number(update.timestamp) * 1000 > now + 30_000 || trips.ts - Number(update.timestamp) * 1000 > MAX_FEED_AGE)) { invalid++; continue; }
    seenTrips.add(identity);
    const direction = owns(trip, 'directionId') ? Number(trip.directionId) : -1;
    const key = `${trip.routeId}|${direction}`;
    const group = grouped.get(key) || { route_id: trip.routeId, direction, n: 0, delays: [] };
    group.n++;
    let delay: number | null = null;
    // Use the first upcoming, explicitly delayed stop event. Never turn a missing field into zero.
    for (const stop of update.stopTimeUpdate || []) {
      if (stop.scheduleRelationship === 1 || stop.scheduleRelationship === 2) continue;
      for (const event of [stop.arrival, stop.departure]) {
        if (event && owns(event, 'delay') && finite(event.delay) && event.time
          && Number(event.time) * 1000 >= trips.ts - 30_000) { delay = event.delay; break; }
      }
      if (delay !== null) break;
    }
    if (delay === null && owns(update, 'delay') && finite(update.delay)) delay = update.delay;
    if (delay !== null && Math.abs(delay) <= 7200) group.delays.push(delay); else missing++;
    grouped.set(key, group);
  }
  const routes: RouteRow[] = [...grouped.entries()].map(([key, g]) => ({
    route_key: key, route_id: g.route_id, direction: g.direction,
    label: `${labels[g.route_id] || `Route ${g.route_id}`} · direction ${g.direction < 0 ? 'unknown' : g.direction}`,
    n: g.n, with_delay: g.delays.length, mean_delay: g.delays.length ? average(g.delays) : null,
    median_delay: quantile(g.delays, .5), p90_delay: quantile(g.delays, .9)
  })).sort((a, b) => a.route_key.localeCompare(b.route_key, undefined, { numeric: true }));
  const candidates: (Position & { entity_id: string })[] = [];
  const quality: PositionQuality = { duplicate_entity_ids: vehicles.message.entity.length - new Set(vehicles.message.entity.map(e => e.id)).size,
    invalid_records: 0, duplicate_records: 0, conflicting_records: 0 };
  for (const entity of vehicles.message.entity) {
    const v = entity.vehicle, p = v?.position, trip = v?.trip;
    const observedAt = v?.timestamp ? Number(v.timestamp) * 1000 : NaN;
    if (entity.isDeleted || !entity.id || !v || !p || !trip?.routeId || !v.vehicle?.id || !finite(p.latitude) || !finite(p.longitude)
      || p.latitude < 40 || p.latitude > 50 || p.longitude < -100 || p.longitude > -85
      || !Number.isFinite(observedAt) || observedAt > now + 30_000
      || now - observedAt > MAX_FEED_AGE || vehicles.ts - observedAt > MAX_FEED_AGE) { quality.invalid_records++; continue; }
    const dir = owns(trip, 'directionId') ? Number(trip.directionId) : -1;
    candidates.push({ entity_id: entity.id, route_key: `${trip.routeId}|${dir}`, route_id: trip.routeId, vehicle_id: v.vehicle.id,
      lat: p.latitude, lon: p.longitude, observed_at: observedAt });
  }
  const resolve = (rows: typeof candidates, key: 'entity_id' | 'vehicle_id') => {
    const groups = new Map<string, typeof candidates>();
    for (const row of rows) { const group = groups.get(row[key]) || []; group.push(row); groups.set(row[key], group); }
    const accepted: typeof candidates = [];
    for (const group of groups.values()) {
      const newestAt = Math.max(...group.map(p => p.observed_at));
      const newest = group.filter(p => p.observed_at === newestAt), chosen = newest[0];
      // An entity cannot identify two vehicles. Equally recent, contradictory
      // locations/routes are ambiguous: omit the group, never pick by feed order.
      if (new Set(group.map(p => p.vehicle_id)).size > 1 || newest.some(p => p.lat !== chosen.lat || p.lon !== chosen.lon || p.route_key !== chosen.route_key)) {
        quality.conflicting_records += group.length; continue;
      }
      quality.duplicate_records += group.length - 1;
      accepted.push(chosen);
    }
    return accepted;
  };
  const positions: Position[] = resolve(resolve(candidates, 'entity_id'), 'vehicle_id')
    .map(({ entity_id, ...position }) => position).sort((a, b) => a.vehicle_id.localeCompare(b.vehicle_id, undefined, { numeric: true }));
  const invalidPositions = quality.invalid_records + quality.duplicate_records + quality.conflicting_records;
  return { source_ts: trips.ts, vehicle_source_ts: vehicles.ts, fetched_at: now, routes, positions,
    input_trips: trips.message.entity.length, cancelled_trips: cancelled, duplicate_trips: duplicate,
    invalid_trips: invalid, missing_delay: missing, input_positions: vehicles.message.entity.length, invalid_positions: invalidPositions, position_quality: quality };
}

export type Prediction = { route_key: string; feature_ts: number; issued_at: number; target_at: number; current_delay: number; slope: number; persistence: number; candidate: number; model_version: string };
export type FittedModel = { route_key: string; trained_at: number; version: string; intercept: number; beta_current: number; beta_slope: number; train_n: number; test_n: number; test_mae: number; baseline_mae: number; test_start: number; test_end: number };
export function predictionFor(route: RouteRow, sourceTs: number, previous: { source_ts: number; mean_delay: number } | undefined, model?: FittedModel, issuedAt = sourceTs): Prediction | null {
  if (!finite(route.mean_delay) || route.with_delay < 2) return null;
  const gap = previous ? sourceTs - previous.source_ts : 0;
  const slope = previous && gap >= 120_000 && gap <= 8 * 60_000 ? (route.mean_delay - previous.mean_delay) / (gap / HORIZON) : 0;
  const candidate = model ? model.intercept + model.beta_current * route.mean_delay + model.beta_slope * slope
    : route.mean_delay + .5 * slope;
  return { route_key: route.route_key, feature_ts: sourceTs, issued_at: issuedAt, target_at: issuedAt + HORIZON,
    current_delay: route.mean_delay, slope, persistence: route.mean_delay,
    candidate: Math.max(-7200, Math.min(7200, candidate)), model_version: model?.version || 'damped-trend-v1-untrained' };
}
export type MaturedRow = { issued_at: number; target_at: number; observed_at: number; current_delay: number; slope: number; observed: number };
function solve(a: number[][], b: number[]): number[] | null {
  const m = a.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let pivot = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    if (Math.abs(m[c][c]) < 1e-10) return null;
    const divisor = m[c][c]; for (let j = c; j < 4; j++) m[c][j] /= divisor;
    for (let r = 0; r < 3; r++) if (r !== c) { const factor = m[r][c]; for (let j = c; j < 4; j++) m[r][j] -= factor * m[c][j]; }
  }
  const result = m.map(row => row[3]); return result.every(finite) ? result : null;
}
export function fitTemporalModel(routeKey: string, data: MaturedRow[], now: number): FittedModel | null {
  const rows = data.filter(r => r.observed_at <= now && [r.current_delay, r.slope, r.observed].every(finite)).sort((a, b) => a.issued_at - b.issued_at);
  if (rows.length < 80) return null;
  const testStart = rows[Math.floor(rows.length * .8)].issued_at;
  // Purge overlap: every training label must have been observed before the first test forecast.
  const train = rows.filter(r => r.observed_at < testStart), test = rows.filter(r => r.issued_at >= testStart);
  if (train.length < 40 || test.length < 15 || test[test.length - 1].issued_at - test[0].issued_at < 14 * 60_000) return null;
  const a = Array.from({ length: 3 }, () => [0, 0, 0]), b = [0, 0, 0];
  for (const r of train) {
    const x = [1, r.current_delay / 60, r.slope / 60], y = r.observed / 60;
    for (let i = 0; i < 3; i++) { b[i] += x[i] * y; for (let j = 0; j < 3; j++) a[i][j] += x[i] * x[j]; }
  }
  a[1][1] += 1; a[2][2] += 1;
  const beta = solve(a, b); if (!beta) return null;
  const testMae = average(test.map(r => Math.abs(r.observed - Math.max(-7200, Math.min(7200, beta[0] * 60 + beta[1] * r.current_delay + beta[2] * r.slope)))));
  const baselineMae = average(test.map(r => Math.abs(r.observed - r.current_delay)));
  return { route_key: routeKey, trained_at: now, version: `ridge-v1-${now}`, intercept: beta[0] * 60,
    beta_current: beta[1], beta_slope: beta[2], train_n: train.length, test_n: test.length,
    test_mae: testMae, baseline_mae: baselineMae, test_start: testStart, test_end: test[test.length - 1].issued_at };
}

export type SeismicMetrics = Record<string, number>;
export function parseSeismic(metrics: unknown, status: string, qualityText: string) {
  if (!metrics || typeof metrics !== 'object') throw new Error('Missing model metrics');
  const m = metrics as SeismicMetrics;
  for (const key of ['mae', 'rmse', 'r2', 'pi90_coverage_raw', 'pi90_coverage_conformal', 'n_train', 'n_cal', 'n_test']) if (!finite(m[key])) throw new Error(`Invalid metric: ${key}`);
  if (m.mae < 0 || m.rmse < 0 || m.pi90_coverage_raw < 0 || m.pi90_coverage_raw > 1 || m.pi90_coverage_conformal < 0 || m.pi90_coverage_conformal > 1) throw new Error('Metric range validation failed');
  for (const key of ['n_train', 'n_cal', 'n_test']) if (!Number.isInteger(m[key]) || m[key] <= 0) throw new Error(`Invalid sample count: ${key}`);
  const generated = status.match(/Auto-generated (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC/);
  if (!generated) throw new Error('Missing upstream generated timestamp');
  const generatedAt = Date.parse(generated[1].replace(' ', 'T') + ':00Z');
  const readCount = (pattern: RegExp) => { const match = status.match(pattern); if (!match) throw new Error('Missing upstream catalog count'); return Number(match[1].replace(/,/g, '')); };
  const counts = { catalog: readCount(/Events in catalog\s*\|\s*\*\*([\d,]+)/), scored: readCount(/\| Scored\s*\|\s*([\d,]+)/), flagged: readCount(/Flagged for review\s*\|\s*\*\*([\d,]+)/) };
  if (counts.flagged > counts.scored || counts.scored > counts.catalog) throw new Error('Inconsistent upstream counts');
  const rounded = status.match(/\| ([\d.]+) \| ([\d.]+) \| (-?[\d.]+) \| (\d+)% → (\d+)% \|/);
  if (!rounded || Math.abs(Number(rounded[1]) - m.mae) > .00051 || Math.abs(Number(rounded[2]) - m.rmse) > .00051
    || Math.abs(Number(rounded[3]) - m.r2) > .00051 || Math.abs(Number(rounded[4]) / 100 - m.pi90_coverage_raw) > .0051
    || Math.abs(Number(rounded[5]) / 100 - m.pi90_coverage_conformal) > .0051) throw new Error('STATUS and metrics disagree');
  const checks = qualityText.split('\n').filter(row => /^\| Expect/.test(row)).map(row => {
    const cells = row.split('|').map(c => c.trim()); return { expectation: cells[1], column: cells[2], critical: cells[3] === 'yes', result: cells[4] };
  });
  if (!checks.length || checks.some(c => !['PASS', 'FAIL'].includes(c.result))) throw new Error('Unrecognized validation report');
  return { generated_at: generatedAt, metrics: m, counts, quality: checks };
}

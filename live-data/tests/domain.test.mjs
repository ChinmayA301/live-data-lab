import test from 'node:test';
import assert from 'node:assert/strict';
import gtfs from 'gtfs-realtime-bindings';
import fs from 'node:fs';
import { parseTransit, parseSeismic, predictionFor, fitTemporalModel, HORIZON } from '../src/domain.ts';

const now = Date.UTC(2026, 10, 12, 12, 0);
const feed = entities => gtfs.transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: now / 1000 }, entity: entities }).finish();
const trip = (id, delay, extra = {}) => ({ id, tripUpdate: { trip: { tripId: id, routeId: '10', startDate: '20261112', directionId: 0 }, stopTimeUpdate: [{ stopSequence: 1, departure: { time: now / 1000 + 120, ...(delay === undefined ? {} : { delay }) } }], ...extra } });
const vehicle = (id, lat = 44.98, lon = -93.26, timestamp = now / 1000) => ({ id, vehicle: { vehicle: { id }, trip: { routeId: '10', directionId: 0 }, position: { latitude: lat, longitude: lon }, ...(timestamp === undefined ? {} : { timestamp }) } });

test('missing delay stays missing; explicit zero and negative delay remain observations', () => {
  const result = parseTransit(feed([trip('a', undefined), trip('b', 0), trip('c', -60), trip('d', 180)]), feed([]), { '10': 'Route 10' }, now);
  assert.equal(result.routes[0].n, 4); assert.equal(result.routes[0].with_delay, 3);
  assert.equal(result.routes[0].mean_delay, 40); assert.equal(result.missing_delay, 1);
  assert.equal(result.routes[0].median_delay, 0);
});
test('bad locations and missing or stale timestamps are rejected without synthetic positions', () => {
  const noTimestamp = vehicle('missing'); delete noTimestamp.vehicle.timestamp;
  const result = parseTransit(feed([trip('a', 30)]), feed([vehicle('valid'), vehicle('zero', 0, 0), noTimestamp, vehicle('old', 44.98, -93.26, now / 1000 - 1000)]), {}, now);
  assert.equal(result.positions.length, 1); assert.equal(result.invalid_positions, 3);
});
test('recorded Metro Transit duplicate placeholder cannot hide its valid vehicle observation', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('fixtures/metro-duplicate-vehicle.json', import.meta.url)));
  const vehicleBytes = gtfs.transit_realtime.FeedMessage.encode(fixture.feed).finish();
  const tripBytes = gtfs.transit_realtime.FeedMessage.encode({ header: fixture.feed.header, entity: [] }).finish();
  const result = parseTransit(tripBytes, vehicleBytes, {}, Date.parse(fixture.captured_at));
  assert.deepEqual(result.positions.map(p => p.vehicle_id), ['1855', '2029']);
  const observed = fixture.feed.entity.find(e => e.vehicle.vehicle.id === '2029' && e.vehicle.timestamp);
  assert.equal(result.positions[1].lat, observed.vehicle.position.latitude);
  assert.equal(result.positions[1].lon, observed.vehicle.position.longitude);
  assert.deepEqual(result.position_quality, { duplicate_entity_ids: 1, invalid_records: 1, duplicate_records: 0, conflicting_records: 0 });
  assert.equal(result.invalid_positions, 1);
  assert.equal(result.positions.length + result.invalid_positions, result.input_positions);
});
test('vehicle identities resolve by observation time; ambiguous conflicts are omitted regardless of order', () => {
  const older = vehicle('v', 44.9, -93.2, now / 1000 - 30);
  const newest = vehicle('v', 44.98, -93.26);
  const otherEntity = structuredClone(newest); otherEntity.id = 'another-entity';
  const conflict = vehicle('conflict', 44.9, -93.2), conflicting = vehicle('conflict', 44.8, -93.1);
  const reusedId = vehicle('shared'); reusedId.vehicle.vehicle.id = 'different-vehicle';
  const deleted = vehicle('deleted'); deleted.isDeleted = true;
  const rows = [older, newest, otherEntity, conflict, conflicting, vehicle('shared'), reusedId, deleted];
  for (const entities of [rows, [...rows].reverse()]) {
    const result = parseTransit(feed([]), feed(entities), {}, now);
    assert.deepEqual(result.positions, [{ route_key: '10|0', route_id: '10', vehicle_id: 'v', lat: Math.fround(44.98), lon: Math.fround(-93.26), observed_at: now }]);
    assert.deepEqual(result.position_quality, { duplicate_entity_ids: 3, invalid_records: 1, duplicate_records: 2, conflicting_records: 4 });
    assert.equal(result.positions.length + result.invalid_positions, rows.length);
  }
});
test('vehicle age is bounded against the capture clock as well as the feed header', () => {
  const header = { gtfsRealtimeVersion: '2.0', timestamp: now / 1000 - 120 };
  const vehicles = gtfs.transit_realtime.FeedMessage.encode({ header, entity: [vehicle('too-old', 44.98, -93.26, now / 1000 - 240)] }).finish();
  const result = parseTransit(feed([]), vehicles, {}, now);
  assert.equal(result.positions.length, 0); assert.equal(result.invalid_positions, 1);
});
test('stale/future sources, duplicate identifiers, and differential feeds fail closed', () => {
  assert.throws(() => parseTransit(feed([]), feed([]), {}, now + 181_000), /Stale/);
  assert.throws(() => parseTransit(feed([]), feed([]), {}, now - 31_000), /future/);
  assert.throws(() => parseTransit(feed([trip('a', 1), trip('a', 2)]), feed([]), {}, now), /Duplicate/);
  const differential = gtfs.transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', incrementality: 1, timestamp: now / 1000 }, entity: [] }).finish();
  assert.throws(() => parseTransit(differential, feed([]), {}, now), /Differential/);
});
test('cancelled, skipped, duplicate trips, and missing directions are handled explicitly', () => {
  const a = trip('a', 30), duplicate = { ...a, id: 'second-entity' };
  const cancelled = trip('cancel', 20); cancelled.tripUpdate.trip.scheduleRelationship = 3;
  const skipped = trip('skip', 90); skipped.tripUpdate.stopTimeUpdate[0].scheduleRelationship = 1;
  const unknown = trip('unknown', 10); delete unknown.tripUpdate.trip.directionId;
  const result = parseTransit(feed([a, duplicate, cancelled, skipped, unknown]), feed([]), {}, now);
  assert.equal(result.cancelled_trips, 1); assert.equal(result.duplicate_trips, 1); assert.equal(result.missing_delay, 1);
  assert(result.routes.some(r => r.direction === -1));
});
test('forecasts require two distinct trip estimates and use only earlier features', () => {
  const route = { route_key: '10|0', mean_delay: 120, with_delay: 2 };
  const p = predictionFor(route, now, { source_ts: now - 180_000, mean_delay: 90 });
  assert.equal(p.persistence, 120); assert.equal(p.target_at, now + HORIZON); assert.equal(p.candidate, 170);
  assert.equal(predictionFor({ ...route, with_delay: 1 }, now), null);
  assert.equal(predictionFor({ ...route, mean_delay: null }, now), null);
  const delayedIssue = predictionFor(route, now, undefined, undefined, now + 90_000);
  assert.equal(delayedIssue.feature_ts, now);
  assert.equal(delayedIssue.issued_at, now + 90_000);
  assert.equal(delayedIssue.target_at, now + 90_000 + HORIZON);
});
test('temporal model purges overlapping labels and reports held-out baseline without guaranteeing improvement', () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({ issued_at: now + i * 60_000, target_at: now + (i + 10) * 60_000,
    observed_at: now + (i + 10) * 60_000, current_delay: 50 + i, slope: i % 7, observed: 60 + i }));
  assert.equal(fitTemporalModel('10|0', rows.slice(0, 20), now + 200 * 60_000), null);
  const model = fitTemporalModel('10|0', rows, now + 200 * 60_000);
  assert.equal(model.train_n, 110); assert.equal(model.test_n, 30); assert.equal(model.baseline_mae, 10);
  assert(model.test_mae < 10); assert.equal(model.test_start, now + 120 * 60_000);
  const changed = structuredClone(rows); for (let i = 120; i < changed.length; i++) changed[i].observed += 1000;
  const second = fitTemporalModel('10|0', changed, now + 200 * 60_000);
  assert.equal(model.intercept, second.intercept); assert.equal(model.beta_current, second.beta_current);
  assert.equal(model.beta_slope, second.beta_slope); assert(second.test_mae > 900);
});
test('upstream seismic status and raw metrics must agree within printed rounding', () => {
  const metrics = { mae: .243407, rmse: .33258, r2: .92011, pi90_coverage_raw: .79439, pi90_coverage_conformal: .91952, n_train: 5775, n_cal: 1926, n_test: 1926 };
  const status = '_Auto-generated 2026-11-12 04:44 UTC by the scheduled job._\n| Events in catalog | **9,873** |\n| Scored | 9,627 |\n| Flagged for review | **403** (4.2%) |\n| 0.243 | 0.333 | 0.920 | 79% → 92% |';
  const quality = '| ExpectColumnValuesToBeUnique | id | yes | PASS | 0 |';
  assert.equal(parseSeismic(metrics, status, quality).counts.flagged, 403);
  assert.throws(() => parseSeismic({ ...metrics, mae: .9 }, status, quality), /disagree/);
  assert.throws(() => parseSeismic(metrics, status.replace('9,627', '10,000'), quality), /counts/);
  assert.throws(() => parseSeismic({ ...metrics, pi90_coverage_raw: 2 }, status, quality), /range/);
});

test('a stale trip record cannot suppress a valid record of the same trip', () => {
  const stale = trip('same', 600, { timestamp: now / 1000 - 600 });
  const valid = trip('same', 30); valid.id = 'fresh-entity';
  const result = parseTransit(feed([stale, valid]), feed([]), {}, now);
  assert.equal(result.invalid_trips, 1);
  assert.equal(result.routes[0].n, 1);
  assert.equal(result.routes[0].mean_delay, 30);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import gtfs from 'gtfs-realtime-bindings';
import worker, { storeTransit as writeTransit, settlePredictions, trainModels, collect } from '../src/worker.ts';
const storeTransit = (db,snapshot,trips,positions,now) => writeTransit(db,snapshot,trips,positions,now,()=>now);

class SqliteD1 {
  constructor() { this.db = new DatabaseSync(':memory:'); for (const name of ['0001_lab.sql','0002_quarantine.sql','0003_forecast_clocks.sql']) this.db.exec(fs.readFileSync(new URL('../migrations/'+name, import.meta.url), 'utf8')); }
  prepare(sql) {
    (this.queries ||= []).push(sql);
    const stmt = this.db.prepare(sql); let args = [];
    const api = { bind(...values) { args = values.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v); return api; },
      async run() { const r = stmt.run(...args); return { success: true, meta: { changes: r.changes } }; },
      async first() { return stmt.get(...args) || null; }, async all() { return { results: stmt.all(...args), success: true }; } }; return api;
  }
  async batch(statements) { this.db.exec('BEGIN'); try { const results = []; for (const s of statements) results.push(await s.run()); this.db.exec('COMMIT'); return results; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
}
const start = Date.UTC(2026, 10, 12, 12);
const snapshot = (t, delay = 120) => ({ source_ts: t, vehicle_source_ts: t, fetched_at: t + 1000,
  routes: [{ route_key: '10|0', route_id: '10', direction: 0, label: 'Route 10 · direction 0', n: 2, with_delay: 2, mean_delay: delay, median_delay: delay, p90_delay: delay }],
  positions: [], input_trips: 2, cancelled_trips: 0, duplicate_trips: 0, invalid_trips: 0, missing_delay: 0, input_positions: 0, invalid_positions: 0 });
const bytes = t => new TextEncoder().encode(String(t));
test('ingestion is idempotent, monotonic, and stores replayable raw bytes', async () => {
  const db = new SqliteD1();
  await storeTransit(db, snapshot(start), bytes(start), bytes(start), start + 1000);
  await storeTransit(db, snapshot(start), bytes(start), bytes(start), start + 2000);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM predictions').get().n, 2);
  await storeTransit(db, snapshot(start - 60_000), bytes(start - 60_000), bytes(start - 60_000), start + 2000);
  assert.equal(JSON.parse(db.db.prepare("SELECT value FROM state WHERE key='transit_latest'").get().value).source_ts, start);
  const raw = db.db.prepare("SELECT body FROM raw_feeds WHERE kind='tripupdates' ORDER BY source_ts DESC LIMIT 1").get().body;
  const text = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  assert.equal(text, String(start));
  await assert.rejects(storeTransit(db, snapshot(start), bytes('revision'), bytes(start), start + 3000), /revised/);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM quarantined_feeds').get().n, 2);
});
test('outcomes are matched after the horizon; gaps remain unevaluated', async () => {
  const db = new SqliteD1();
  await storeTransit(db, snapshot(start), bytes(start), bytes(start), start);
  await storeTransit(db, snapshot(start + 9 * 60_000, 180), bytes(start + 9 * 60_000), bytes(start + 9 * 60_000), start + 9 * 60_000);
  assert.equal(db.db.prepare("SELECT observed FROM predictions WHERE issued_at=? AND route_key='10|0'").get(start).observed, null);
  await storeTransit(db, snapshot(start + 10 * 60_000, 150), bytes(start + 10 * 60_000), bytes(start + 10 * 60_000), start + 10 * 60_000);
  const result = db.db.prepare("SELECT * FROM predictions WHERE issued_at=? AND route_key='10|0'").get(start);
  assert.equal(result.observed, 150); assert.equal(result.absolute_error_baseline, 30);
  await settlePredictions(db, start + 40 * 60_000);
  assert.equal(db.db.prepare("SELECT observed FROM predictions WHERE issued_at=? AND route_key='10|0'").get(start + 9 * 60_000).observed, null);
});
test('a failed normalization transaction cannot publish a partial snapshot', async () => {
  const db = new SqliteD1(); const invalid = snapshot(start); invalid.routes.push(invalid.routes[0]);
  await assert.rejects(storeTransit(db, invalid, bytes(start), bytes(start), start));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM state').get().n, 0);
});
test('read-only API exposes empty state honestly and rejects invalid selectors or writes', async () => {
  const db = new SqliteD1(), env = { DB: db, ASSETS: { fetch: () => new Response('asset') } };
  const empty = await worker.fetch(new Request('https://example.test/api/transit'), env);
  assert.equal(empty.status, 200); assert.equal((await empty.json()).available, false);
  assert.equal((await worker.fetch(new Request('https://example.test/api/transit?route=bad-selector'),env)).status,400);
  assert.equal((await worker.fetch(new Request('https://example.test/api/transit?window=7d'),env)).status,400);
  assert.equal((await worker.fetch(new Request('https://example.test/api/transit',{method:'POST'}),env)).status,405);
  await trainModels(db,start);
  const training = JSON.parse(db.db.prepare("SELECT value FROM state WHERE key='model_training'").get().value);
  assert.equal(training.eligible_routes,0); assert.equal(training.maximum_route_groups,16);
});
test('a stale upstream feed is quarantined and cannot replace accepted state', async t => {
  const db=new SqliteD1(), now=Date.now(), env={DB:db};
  db.db.prepare('INSERT INTO state VALUES(?,?,?)').run('route_labels',now,JSON.stringify({fetched_at:now,labels:{'10':'Route 10'}}));
  db.db.prepare('INSERT INTO state VALUES(?,?,?)').run('model_training',now,JSON.stringify({trained_at:now}));
  db.db.prepare('INSERT INTO state VALUES(?,?,?)').run('cleanup',now,JSON.stringify({at:now}));
  db.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)').run('seismic-fixture','seismic',now,now,'success',now,0,0,0,'Test fixture suppresses unrelated seismic network calls');
  let sourceTs=Math.floor(now/1000);
  t.mock.method(globalThis,'fetch',async()=>new Response(gtfs.transit_realtime.FeedMessage.encode({header:{gtfsRealtimeVersion:'2.0',incrementality:0,timestamp:sourceTs},entity:[]}).finish()));
  await collect(env,now);
  const accepted=db.db.prepare("SELECT value FROM state WHERE key='transit_latest'").get().value;
  sourceTs-=360;
  await collect(env,now+1000);
  assert.equal(db.db.prepare("SELECT value FROM state WHERE key='transit_latest'").get().value,accepted);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM quarantined_feeds').get().n,2);
  const attempts=db.db.prepare("SELECT status,message FROM runs WHERE pipeline='transit' ORDER BY started_at").all();
  assert.deepEqual(attempts.map(r=>r.status),['success','failed']);assert.match(attempts[1].message,/Stale/);
});
test('scheduled collection recovers from 522 and publishes valid positions despite recorded duplicate placeholders', async t => {
  const fixture=JSON.parse(fs.readFileSync(new URL('fixtures/metro-duplicate-vehicle.json',import.meta.url)));
  const now=Date.parse(fixture.captured_at),db=new SqliteD1(),env={DB:db};
  t.mock.method(Date,'now',()=>now);
  for(const [key,value] of [['route_labels',{fetched_at:now,labels:{'10':'Route 10','54':'Route 54'}}],['model_training',{trained_at:now}],['cleanup',{at:now}]])
    db.db.prepare('INSERT INTO state VALUES(?,?,?)').run(key,now,JSON.stringify(value));
  db.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)').run('seismic-fixture','seismic',now,now,'success',now,0,0,0,'Test fixture suppresses unrelated seismic network calls');
  let positionCalls=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.endsWith('/vehiclepositions.pb')) {
      if(++positionCalls===1)return new Response('temporary upstream timeout',{status:522});
      return new Response(gtfs.transit_realtime.FeedMessage.encode(fixture.feed).finish());
    }
    assert(url.endsWith('/tripupdates.pb'));
    return new Response(gtfs.transit_realtime.FeedMessage.encode({header:fixture.feed.header,entity:[]}).finish());
  });
  await collect(env,now);
  const response=await worker.fetch(new Request('https://example.test/api/transit'),env);
  const result=await response.json();
  assert.equal(positionCalls,2);assert.equal(result.available,true);
  assert.deepEqual(result.latest.positions.map(p=>p.vehicle_id),['1855','2029']);
  assert.equal(result.latest.invalid_positions,1);
  assert.equal(result.latest.position_quality.duplicate_entity_ids,1);
  assert.equal(result.runs[0].status,'success');assert.equal(result.runs[0].accepted_rows,2);
  assert.match(result.runs[0].message,/1 repeated vehicle entity IDs/);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n,1);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM raw_feeds').get().n,2);
});
test('the bounded fitting job persists and updates ridge candidates, then forecasts with their versions', async () => {
  const db=new SqliteD1();
  // Synthetic clocked fixtures exercise a future eligible model state without
  // passing them off as live transit outcomes or inserting them in production.
  for(let i=0;i<150;i++) {
    const ts=start+i*60_000;
    await storeTransit(db,snapshot(ts,50+i),bytes(ts),bytes(ts),ts);
  }
  await trainModels(db,start+200*60_000);
  const fitted=db.db.prepare('SELECT * FROM models ORDER BY route_key').all();
  assert.equal(fitted.length,2);assert(fitted.every(m=>m.train_n>=40&&m.test_n>=15));
  assert(fitted.every(m=>Number.isFinite(m.test_mae)&&m.baseline_mae===10));
  await trainModels(db,start+205*60_000);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM models').get().n,2);
  const ts=start+210*60_000;await storeTransit(db,snapshot(ts,260),bytes(ts),bytes(ts),ts);
  const p=db.db.prepare("SELECT * FROM predictions WHERE route_key='all' ORDER BY issued_at DESC LIMIT 1").get();
  assert.equal(p.model_version,`ridge-v1-${start+205*60_000}`);assert.equal(p.feature_ts,ts);
  assert.equal(p.target_at-p.issued_at,600_000);
});

test('collector history and settlement use indexed keys instead of full growing-table scans', async () => {
  const db=new SqliteD1();
  await storeTransit(db,snapshot(start),bytes(start),bytes(start),start);
  await storeTransit(db,snapshot(start+600_000),bytes(start+600_000),bytes(start+600_000),start+600_000);
  const history=db.queries.find(sql=>sql.startsWith('SELECT route_key,source_ts,mean_delay'));
  const historyPlan=db.db.prepare('EXPLAIN QUERY PLAN '+history).all('["10|0","all"]',start-600_000,start).map(r=>r.detail).join(' ');
  assert.match(historyPlan,/SEARCH route_observations USING INDEX route_time/);
  const errors=db.queries.find(sql=>sql.startsWith('UPDATE predictions SET absolute_error_baseline'));
  const errorPlan=db.db.prepare('EXPLAIN QUERY PLAN '+errors).all('[]').map(r=>r.detail).join(' ');
  assert.match(errorPlan,/SEARCH predictions USING (?:COVERING )?INDEX/);
  assert.doesNotMatch(errorPlan,/SCAN predictions/);
});

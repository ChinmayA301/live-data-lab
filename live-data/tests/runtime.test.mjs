import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../runtime/sqlite.mjs';

test('portable SQLite preserves state across restart and rolls back failed batches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-portable-'));
  let db = new SqliteStore(join(dir, 'lab.sqlite'));
  try {
    await db.prepare('INSERT INTO state VALUES(?,?,?)').bind('fixture', 123, '{"real":false}').run();
    await assert.rejects(db.batch([
      db.prepare('INSERT INTO state VALUES(?,?,?)').bind('rollback', 456, '{}'),
      db.prepare('INSERT INTO state VALUES(?,?,?)').bind('fixture', 456, '{}')
    ]));
    assert.equal(await db.prepare("SELECT * FROM state WHERE key='rollback'").first(), null);
    db.close(); db = new SqliteStore(join(dir, 'lab.sqlite'));
    assert.equal((await db.prepare("SELECT * FROM state WHERE key='fixture'").first()).updated_at,123);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lab_migrations').first()).n,3);
    await db.prepare('INSERT INTO raw_feeds VALUES(?,?,?,?,?,?,?)').bind('x','test',1,1,'x',3,new Uint8Array([1,2,3]).buffer).run();
    assert.deepEqual((await db.prepare("SELECT body FROM raw_feeds WHERE hash='x'").first()).body,new Uint8Array([1,2,3]));
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('ephemeral runners preserve the prior timestamp contract across restarts', async () => {
  const { default: worker, storeTransit } = await import('../src/worker.ts');
  const db = new SqliteStore(), t = Date.now();
  const previous = { id: 'accepted', source_ts: t, vehicle_source_ts: t, fetched_at: t,
    routes: [], positions: [], input_trips: 0, input_positions: 0, invalid_positions: 0 };
  try {
    await db.prepare('INSERT INTO state VALUES(?,?,?)').bind('transit_latest',t,JSON.stringify(previous)).run();
    await storeTransit(db,{...previous,source_ts:t-60000},new Uint8Array([1]),new Uint8Array([2]),t);
    const result = await (await worker.fetch(new Request('http://snapshot/api/transit'),{DB:db})).json();
    assert.equal(result.available,true);
    assert.equal(result.latest.source_ts,t);
    assert.equal(result.latest.id,'accepted');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM snapshots').first()).n,0);
    await assert.rejects(storeTransit(db,previous,new Uint8Array([3]),new Uint8Array([4]),t),/revised/);
    assert.equal(JSON.parse((await db.prepare("SELECT value FROM state WHERE key='transit_latest'").first()).value).id,'accepted');
  } finally { db.close(); }
});

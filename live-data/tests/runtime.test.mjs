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

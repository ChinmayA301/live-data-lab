import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

// Implements the small SQL interface used by the collector on ordinary SQLite.
export class SqliteStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS lab_migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)');
    for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) {
      const sql = readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const applied = this.db.prepare('SELECT sha256 FROM lab_migrations WHERE name=?').get(name);
      if (applied) { if (applied.sha256 !== hash) throw new Error(`Applied migration changed: ${name}`); continue; }
      this.db.exec('BEGIN IMMEDIATE');
      try { this.db.exec(sql); this.db.prepare('INSERT INTO lab_migrations VALUES(?,?)').run(name, hash); this.db.exec('COMMIT'); }
      catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
    }
  }
  prepare(sql) {
    const statement = this.db.prepare(sql); let args = [];
    const api = {
      bind(...values) { args = values.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v); return api; },
      execute() { const r = statement.run(...args); return { success: true, meta: { changes: r.changes } }; },
      async run() { return api.execute(); },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args), success: true }; }
    };
    return api;
  }
  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(s => s.execute()); this.db.exec('COMMIT'); return results; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

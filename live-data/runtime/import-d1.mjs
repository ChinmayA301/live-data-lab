// Import only an export obtained from this lab's D1 database into a new file.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteStore } from './sqlite.mjs';
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw Error('Usage: node runtime/import-d1.mjs export.sql NEW-database.sqlite');
if (existsSync(destination)) throw Error('Destination exists; import refuses to overwrite it');
mkdirSync(dirname(resolve(destination)), { recursive: true });
const db = new DatabaseSync(destination), expected = new SqliteStore();
try {
  db.exec(readFileSync(source, 'utf8'));
  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (Object.values(integrity)[0] !== 'ok') throw Error('Imported database failed integrity check');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error('Imported database has foreign-key violations');
  const tables = expected.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'lab_migrations'").all();
  for (const { name } of tables) {
    const columns = connection => connection.prepare('SELECT name,type,"notnull" AS required,pk FROM pragma_table_info(?)').all(name);
    // Compare schema structurally before recording the existing migration state.
    if (JSON.stringify(columns(db)) !== JSON.stringify(columns(expected.db))) throw Error(`Unexpected imported schema: ${name}`);
  }
  db.exec('CREATE TABLE IF NOT EXISTS lab_migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)');
  for (const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort()) {
    const hash=createHash('sha256').update(readFileSync(new URL('../migrations/'+name,import.meta.url))).digest('hex');
    db.prepare('INSERT INTO lab_migrations VALUES(?,?)').run(name,hash);
  }
  console.log('Imported schema, integrity and foreign keys verified. Source export retained.');
} finally { expected.close(); db.close(); }

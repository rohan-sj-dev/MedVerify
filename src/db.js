// Opens the database and makes sure every table exists.
//
// PGlite is real PostgreSQL running inside Node, saved to a folder on disk,
// so nothing has to be installed. Give no folder for a throwaway in-memory
// database, which is what the tests use.

import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = new URL('../db/migrations/', import.meta.url);

export async function openDatabase(folder) {
  if (folder) mkdirSync(folder, { recursive: true });
  const db = folder ? new PGlite(folder) : new PGlite();

  // Remember which .sql files have already run, so each runs exactly once.
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
  const { rows } = await db.query('SELECT name FROM schema_migrations');
  const done = rows.map((row) => row.name);

  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (!file.endsWith('.sql') || done.includes(file)) continue;
    const sql = readFileSync(new URL(file, MIGRATIONS), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
  }

  return db;
}

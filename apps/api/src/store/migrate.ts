import type { SchemaFile } from './schema/index.js';

/**
 * Brings one object's SQLite up to the current schema.
 *
 * Runs from the object's constructor, under `blockConcurrencyWhile`, so no request sees a
 * half-migrated database. Each file the object has no record of is applied in one
 * transaction with the row that records it, which is what makes "fully migrated or
 * untouched" true per file: a file that fails part way rolls back, its name is not
 * recorded, the constructor throws, the object resets, and the next wake tries again.
 * Nothing about a failure is hidden — it surfaces as the request's error and in the
 * daily sweep, which wakes every object for this reason.
 *
 * `_migrations` itself is created here rather than in a schema file, so the runner can
 * read it before it has applied anything. `IF NOT EXISTS` is deliberate: it is the one
 * statement that runs on every wake.
 *
 * `sql.exec` runs multi-statement text, which is what lets a whole file be one call;
 * bindings are not used because a schema file has nothing to bind.
 */
export function migrate(storage: DurableObjectStorage, files: SchemaFile[]): string[] {
  const sql = storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(
    sql.exec<{ name: string }>('SELECT name FROM _migrations').toArray().map((r) => r.name),
  );
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file.name)) continue;
    storage.transactionSync(() => {
      sql.exec(file.sql);
      sql.exec('INSERT INTO _migrations (name, applied_at) VALUES (?1, ?2)', file.name, Date.now());
    });
    applied.push(file.name);
  }
  return applied;
}

/** The names in `_migrations`, in the order they were applied. */
export function appliedMigrations(storage: DurableObjectStorage): string[] {
  return storage.sql
    .exec<{ name: string }>('SELECT name FROM _migrations ORDER BY applied_at, name')
    .toArray()
    .map((r) => r.name);
}

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import SQLiteESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from '@journeyapps/wa-sqlite';
import type { SearchDb } from './search-index.js';

/**
 * An in-memory database for the search tests, on the engine the browser runs.
 *
 * `wa-sqlite.wasm` is the build the library's persistence worker bundles, so a query
 * that passes here is passing on the FTS5, the bm25 and the stemmer a phone will use:
 * Node's own `node:sqlite` has no FTS5 at all. The browser fetches the WASM; Node cannot
 * fetch a file, so it is read from the package and handed over.
 */
export async function openTestSearchDb(): Promise<SearchDb> {
  const require = createRequire(import.meta.url);
  const module = await SQLiteESMFactory({ wasmBinary: readFileSync(require.resolve('@journeyapps/wa-sqlite/dist/wa-sqlite.wasm')) });
  const sqlite3 = SQLite.Factory(module);
  const db = await sqlite3.open_v2(':memory:');
  return {
    async execute<T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      const rows: T[] = [];
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (params.length > 0) sqlite3.bind_collection(stmt, params as SQLiteCompatibleType[]);
        const names = sqlite3.column_names(stmt);
        while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
          const values = sqlite3.row(stmt);
          rows.push(Object.fromEntries(names.map((name, i) => [name, values[i]])) as T);
        }
      }
      return rows;
    },
    close: async () => {
      await sqlite3.close(db);
    },
  };
}

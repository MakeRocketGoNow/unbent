import init from './0001-init.js';
import changes from './0002-changes.js';

/** One schema file: its name, as recorded in `_migrations`, and the SQL it applies. */
export interface SchemaFile {
  name: string;
  sql: string;
}

/**
 * The store's schema files, in the order they are applied.
 *
 * Append, never edit or reorder. A file that has been applied to any object in production
 * is history: its name is in that object's `_migrations`, and the runner skips it by name,
 * so a change to its text would reach only objects created after the change and leave the
 * fleet with two schemas under one name. A new file goes at the end and is applied to each
 * object on its next wake, whenever that is — which is why every file must be additive
 * and must tolerate running against an object that has been in use under the files before
 * it.
 *
 * TypeScript strings rather than `.sql` files because wrangler bundles the Worker with
 * esbuild and has no rule for importing `.sql`; the D1 migrations are files because
 * `wrangler d1 migrations apply` reads them from disk, which nothing does here.
 */
export const SCHEMA: SchemaFile[] = [
  { name: '0001-init', sql: init },
  { name: '0002-changes', sql: changes },
];

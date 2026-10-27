import init from './0001-init.js';
import changes from './0002-changes.js';
import revisions from './0003-revisions.js';
import revisionProps from './0004-revision-props.js';
import deletedBlobs from './0005-deleted-blobs.js';
import tagsNocase from './0006-tags-nocase.js';
import llmUsage from './0007-llm-usage.js';
import attachmentBytes from './0008-attachment-bytes.js';
import colours from './0009-colours.js';
import notebookViews from './0010-notebook-views.js';
import fieldStyle from './0011-field-style.js';

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
 * object on its next wake, whenever that is, which is why every file must be additive
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
  { name: '0003-revisions', sql: revisions },
  { name: '0004-revision-props', sql: revisionProps },
  { name: '0005-deleted-blobs', sql: deletedBlobs },
  { name: '0006-tags-nocase', sql: tagsNocase },
  { name: '0007-llm-usage', sql: llmUsage },
  { name: '0008-attachment-bytes', sql: attachmentBytes },
  { name: '0009-colours', sql: colours },
  { name: '0010-notebook-views', sql: notebookViews },
  { name: '0011-field-style', sql: fieldStyle },
];

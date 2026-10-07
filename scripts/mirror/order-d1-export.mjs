// @ts-check
//
// Reorders a `wrangler d1 export` so a fresh D1 database can import it (MAK-191).
//
//   node scripts/mirror/order-d1-export.mjs <export.sql> <ordered.sql>
//
// The export writes each table's rows straight after its CREATE TABLE and every index at
// the very end, after all the rows. SQLite checks a foreign key's target for a unique
// index at the moment a row is written, and `PRAGMA defer_foreign_keys` defers only the
// constraint, not that check, so the first row into a table whose foreign key points at
// a column made unique by one of those late indexes fails with "foreign key mismatch".
// The rehearsal of the runbook (MAK-171, part 6) hit it on `oauthClientResource`, and
// D1's import reported it only as `{"D1_RESET_DO":true}`, with nothing imported.
//
// The fix is the order: every CREATE first, then every INSERT. Two other lines go:
// `PRAGMA defer_foreign_keys`, which the import does not need once the order is right,
// and the `sqlite_sequence` rows, which SQLite maintains itself and refuses to have
// written on some builds. Nothing else is in an export of the control plane, and
// anything else found is reported on stderr and kept, after the inserts, so a statement
// this script does not know is seen rather than silently dropped.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Splits export text into statements. A statement starts at a line beginning with a
 * keyword and ends at a line ending in `;`, except a trigger, which holds `;` lines of
 * its own and ends at `END;`. The export puts no `;` inside a string on a line of its
 * own, so this is enough for what `wrangler d1 export` writes; it is not a SQL parser.
 * @param {string} text
 * @returns {string[]}
 */
export function statements(text) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let current = [];
  let inTrigger = false;
  for (const line of text.split('\n')) {
    if (current.length === 0 && line.trim() === '') continue;
    if (current.length === 0 && /^CREATE\s+TRIGGER\b/i.test(line)) inTrigger = true;
    current.push(line);
    const ends = inTrigger ? /^END;\s*$/i.test(line) : /;\s*$/.test(line);
    if (ends) {
      out.push(current.join('\n'));
      current = [];
      inTrigger = false;
    }
  }
  if (current.length) out.push(current.join('\n'));
  return out;
}

/**
 * The export in an order a fresh database accepts: schema, then rows, then whatever
 * else was there. `dropped` names what was left out and `unknown` what was kept without
 * being recognised, for the caller to report.
 * @param {string} text
 */
export function order(text) {
  /** @type {string[]} */
  const schema = [];
  /** @type {string[]} */
  const rows = [];
  /** @type {string[]} */
  const unknown = [];
  /** @type {string[]} */
  const dropped = [];
  for (const s of statements(text)) {
    if (/^CREATE\b/i.test(s)) schema.push(s);
    else if (/^INSERT\s+INTO\s+"?sqlite_sequence"?/i.test(s) || /^DELETE\s+FROM\s+"?sqlite_sequence"?/i.test(s)) dropped.push(s);
    else if (/^PRAGMA\b/i.test(s)) dropped.push(s);
    else if (/^INSERT\b/i.test(s)) rows.push(s);
    else unknown.push(s);
  }
  return { sql: [...schema, ...rows, ...unknown].join('\n') + '\n', schema: schema.length, rows: rows.length, dropped, unknown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node scripts/mirror/order-d1-export.mjs <export.sql> <ordered.sql>');
    process.exit(2);
  }
  const result = order(readFileSync(input, 'utf8'));
  writeFileSync(output, result.sql);
  console.log(`${result.schema} schema statement(s), then ${result.rows} row(s); ${result.dropped.length} line(s) dropped.`);
  for (const s of result.unknown) console.error(`kept, after the rows, a statement this script does not know: ${s.slice(0, 60)}…`);
}

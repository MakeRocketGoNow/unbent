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
// The fix is the order: every CREATE first, then every INSERT. The export's
// `PRAGMA defer_foreign_keys` stays, and stays first: it cannot cure the index problem,
// but it is what lets a child row be written before its parent, and the export orders
// tables by creation, which a rebuild (0013's and 0017's create-copy-drop-rename) moves a
// table to the end of. Without it, a rebuilt `user` would put every session and account
// row before its parent and fail the import the same opaque way. The `sqlite_sequence`
// rows go: the only AUTOINCREMENT table is wrangler's `d1_migrations`, whose next id
// SQLite takes from the rows themselves, so the lines buy nothing, and an import should
// not depend on D1 letting a `sqlite_*` table be written by hand. Nothing else is in an
// export of the control plane; anything else found is kept, after the inserts, reported,
// and makes the exit code non-zero, so a statement this script does not know stops the
// operator rather than reaching D1's all-or-nothing import unseen.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The part of a line that is SQL rather than a `--` comment, and how many single quotes
 * in it open or close a literal, given whether one is open where the line starts. A `--`
 * inside a literal is part of the value.
 * @param {string} line
 * @param {boolean} open
 */
function scan(line, open) {
  let quotes = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "'") {
      quotes++;
      open = !open;
    } else if (!open && line[i] === '-' && line[i + 1] === '-') {
      return { code: line.slice(0, i), quotes };
    }
  }
  return { code: line, quotes };
}

/**
 * Splits export text into statements. A statement ends at a line ending in `;` while no
 * string literal is open, except a trigger, which holds `;` lines of its own and ends at
 * `END;`. Whether a literal is open is the parity of the single quotes seen so far: the
 * export escapes a quote inside a value as `''`, which keeps the count even, and its
 * identifiers hold no apostrophes. A value with a newline after a `;` (`'one;` on one
 * line, `two'` on the next) therefore stays one statement, where a split on the line
 * alone cut it in two and put the tail after every other row (found in review).
 *
 * Comments are read past, not counted. SQLite keeps a CREATE's text as it was written,
 * comments and all, and a comment is prose: `-- the plugin's schema` inside a table's
 * definition (0010's `deviceCode` has one) tipped the parity in review and folded every
 * statement up to the next stray apostrophe into one "schema" statement, rows and all,
 * which put rows back ahead of the indexes this script exists to move. `wrangler d1 migrations apply` happens to
 * strip comments today, which is the only reason that export was clean; a table made
 * any other way keeps them. Not a SQL parser; enough for what `wrangler d1 export`
 * writes.
 * @param {string} text
 * @returns {string[]}
 */
export function statements(text) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let current = [];
  let inTrigger = false;
  let quotes = 0;
  for (const line of text.split('\n')) {
    if (current.length === 0 && line.trim() === '') continue;
    if (current.length === 0 && /^CREATE\s+TRIGGER\b/i.test(line)) inTrigger = true;
    current.push(line);
    const { code, quotes: seen } = scan(line, quotes % 2 === 1);
    quotes += seen;
    const ends = quotes % 2 === 0 && (inTrigger ? /^END;\s*$/i.test(code) : /;\s*$/.test(code));
    if (ends) {
      out.push(current.join('\n'));
      current = [];
      inTrigger = false;
      quotes = 0;
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
  /** @type {string[]} */
  const pragmas = [];
  for (const s of statements(text)) {
    if (/^CREATE\b/i.test(s)) schema.push(s);
    else if (/^INSERT\s+INTO\s+"?sqlite_sequence"?/i.test(s) || /^DELETE\s+FROM\s+"?sqlite_sequence"?/i.test(s)) dropped.push(s);
    else if (/^PRAGMA\s+defer_foreign_keys\b/i.test(s)) pragmas.push(s);
    else if (/^PRAGMA\b/i.test(s)) dropped.push(s);
    else if (/^INSERT\b/i.test(s)) rows.push(s);
    else unknown.push(s);
  }
  return { sql: [...pragmas, ...schema, ...rows, ...unknown].join('\n') + '\n', schema: schema.length, rows: rows.length, dropped, unknown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node scripts/mirror/order-d1-export.mjs <export.sql> <ordered.sql>');
    process.exit(2);
  }
  const result = order(readFileSync(input, 'utf8'));
  writeFileSync(output, result.sql);
  console.log(`${result.schema} schema statement(s), then ${result.rows} row(s); ${result.dropped.length} line(s) dropped; ${result.unknown.length} not recognised.`);
  for (const s of result.unknown) console.error(`kept, after the rows, a statement this script does not know: ${s.slice(0, 60)}…`);
  // The file is written either way, so it can be read; the exit code is what stops a
  // runbook step from feeding it to an import whose own error says nothing.
  if (result.unknown.length > 0) process.exitCode = 1;
}

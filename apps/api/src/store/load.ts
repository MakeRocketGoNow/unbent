/**
 * The pure half of loading a dump into a store (MAK-171, part 4): how the SQL text a dump
 * holds is cut into statements, which of them run, and the error a store answers with
 * while a load is under way. No `cloudflare:workers` import, so the route and the unit
 * tests can use it; the object's side is `UserStore.loadBegin`, `loadPage` and
 * `loadFinish`, which this module exists to keep small.
 *
 * Why the object parses rather than the Worker. The dump reaches the object in pages of
 * raw bytes, cut wherever eight megabytes fall (`LOAD_PAGE_BYTES` in lib/load.ts), since
 * a page is an RPC argument and the ceiling is 32 MiB. Someone has to find the statement
 * boundaries, and the CPU to do it is the object's: a Worker invocation has ten
 * milliseconds on Free, an object request thirty seconds, and the dump's own formatting
 * is in the object for the same reason (`dumpTableOnto`). So the Worker streams bytes and
 * the object keeps the partial statement at a page's end until the next page completes
 * it.
 */

/**
 * The statements of `text` that are whole, and what follows the last one. A statement
 * ends at a `;` outside a string literal and outside a `--` comment — a note's body is in
 * a literal and holds both — except inside a `CREATE TRIGGER`, whose body is statements
 * of its own between `BEGIN` and `END`: there the `;` that ends it is the one that brings
 * the body's depth back to zero. `rest` is the text after the last whole statement, to be
 * put in front of the next page; at the end of a dump it is the file's closing comments.
 *
 * A literal is scanned by its quotes only: `''` inside one is two quotes, each of which
 * flips the state and flips it back, and a blob literal `X'…'` is a literal like any
 * other. The scan jumps between the characters that matter rather than visiting each,
 * since a page is eight megabytes and most of it is literal.
 */
export function scanStatements(text: string): { statements: string[]; rest: string } {
  const statements: string[] = [];
  let start = 0;
  let at = 0;
  let inString = false;
  const NEXT = /'|;|--/g;
  while (at < text.length) {
    if (inString) {
      const close = text.indexOf("'", at);
      if (close === -1) break;
      inString = false;
      at = close + 1;
      continue;
    }
    NEXT.lastIndex = at;
    const m = NEXT.exec(text);
    if (!m) break;
    at = m.index + m[0].length;
    if (m[0] === "'") {
      inString = true;
    } else if (m[0] === '--') {
      const eol = text.indexOf('\n', at);
      if (eol === -1) {
        at = text.length;
        break;
      }
      at = eol + 1;
    } else {
      const candidate = text.slice(start, at);
      if (triggerDepth(candidate) > 0) continue;
      statements.push(candidate);
      start = at;
    }
  }
  return { statements, rest: text.slice(start) };
}

/**
 * How many `BEGIN`s and `CASE`s of a `CREATE TRIGGER` statement are still open — zero for
 * anything that is not one. Counted over the text with its literals and comments removed,
 * so a word in a note's body is never a keyword. A trigger body in this schema is plain
 * inserts and updates, but `CASE … END` inside one would otherwise end the trigger early.
 */
function triggerDepth(candidate: string): number {
  const head = statementText(candidate);
  if (!/^CREATE\s+TRIGGER\b/i.test(head)) return 0;
  const bare = head.replace(/'(?:[^']|'')*'|--[^\n]*/g, (m) => (m.startsWith("'") ? "''" : ''));
  let depth = 0;
  for (const word of bare.match(/\b(?:BEGIN|CASE|END)\b/gi) ?? []) {
    depth += word.toUpperCase() === 'END' ? -1 : 1;
  }
  return depth;
}

/** `statement` without the comment lines and whitespace in front of it. */
export function statementText(statement: string): string {
  return statement.replace(/^(?:\s*--[^\n]*\n?)*\s*/, '');
}

/**
 * What a statement is, for an error: its verb and the name after it, never its values.
 * A dump's `INSERT` carries a note's title and body as literals, and an error about a
 * cut-short or refused statement goes to the log and the operator's answer, where the
 * `Sql` seam already keeps bodies out (it logs 120 characters of a statement on the
 * grounds that a body is bound, not written in). `an INSERT INTO notes`, or
 * `unrecognised` for text that starts with no word at all.
 */
export function statementKind(statement: string): string {
  const m = /^(\w+)(?:\s+(?:OR\s+\w+\s+)?(INTO|FROM|TABLE|TRIGGER|INDEX|VIRTUAL\s+TABLE|VIEW))?\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(statementText(statement));
  if (!m) return 'unrecognised';
  return [m[1], m[2], m[3]].filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

/**
 * Whether a statement of the dump runs, is skipped, or refuses the whole load.
 *
 * Skipped: the `BEGIN` and `COMMIT` that wrap the file, since each page runs in a
 * transaction of the object's own and a nested `BEGIN` is an error; the two
 * `PRAGMA foreign_keys` lines, since a pragma inside a transaction does nothing and the
 * object turns foreign keys off around each page itself; and anything that is only
 * comments; and a `CREATE` or `INSERT` on a table of the runtime's or of SQLite's own
 * (`_cf_*`, `sqlite_*`), which a dump taken before MAK-197 carries — `_cf_KV`, where the
 * object's key-value storage lives, listed in `sqlite_master` once that storage has been
 * written — and which the object being loaded already has, so running it ended the load
 * on its first statement. Run: the `CREATE`s and `INSERT`s a dump is made of, and
 * nothing else, so a file that is not a dump — or a dump someone edited a `DROP` or
 * `DELETE` into — stops the load at its first such top-level statement rather than
 * running it against the account. A trigger's body is not looked into: the schema's own
 * triggers update and delete by design, and a dump is read from the operator's own
 * bucket, so the check is against a file that is not a dump, not against one written to
 * deceive.
 */
export function classify(statement: string): 'run' | 'skip' | 'refuse' {
  const head = statementText(statement);
  if (head === '' || head === ';') return 'skip';
  if (/^(BEGIN|COMMIT|END)\b/i.test(head)) return 'skip';
  if (/^PRAGMA\b/i.test(head)) return 'skip';
  if (RUNTIME_TABLE.test(head)) return 'skip';
  if (/^(CREATE|INSERT)\b/i.test(head)) return 'run';
  return 'refuse';
}

/**
 * A statement that makes or fills a table of the runtime's or of SQLite's own: a
 * `CREATE TABLE`/`INDEX` (with or without `IF NOT EXISTS`) named `_cf_*` or `sqlite_*`,
 * an index `ON` one, or an `INSERT INTO` one; the name may be quoted.
 */
const RUNTIME_TABLE = /^(?:CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(?:_cf_|sqlite_)|CREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+["`]?(?:_cf_|sqlite_)|INSERT\s+INTO\s+["`]?(?:_cf_|sqlite_))/i;

/**
 * The most bytes of SQL text one statement may be run as. The runtime refuses a
 * statement over 100 KB of UTF-8 with `SQLITE_TOOBIG` (measured 2026-10-06: 99,000 ASCII
 * characters run, 101,000 do not, and 40,000 CJK characters — 120 KB — do not either),
 * and a dump writes each row as one `INSERT` with its values as literals: a note body of
 * up to 1.8 MB, a file's text of up to half a million characters. A statement past this
 * runs with its literals bound instead (`liftLiterals`); a bound value may be 2 MB, which
 * a body fits. The limit is bytes and a string's length is UTF-16 units, each at most
 * three bytes, so `tooLongToRun` tests the length first and encodes only what might be
 * over (found in review: the first check counted characters, and a row of curly quotes
 * and dashes could pass it and still be refused).
 */
export const MAX_STATEMENT_BYTES = 90_000;

/** Whether `statement` must run with its literals bound; see `MAX_STATEMENT_BYTES`. */
export function tooLongToRun(statement: string): boolean {
  if (statement.length * 3 <= MAX_STATEMENT_BYTES) return false;
  return new TextEncoder().encode(statement).byteLength > MAX_STATEMENT_BYTES;
}

/**
 * `statement` with every string and blob literal replaced by a numbered parameter, and
 * the values to bind to them in order. Numbers and `NULL` stay in the text, so each
 * value's type is exactly what the dump wrote; a `''` inside a literal is one quote, and
 * an `X'…'` literal binds as bytes. Scanned by `indexOf`, not a regular expression, since
 * the literals are the size that brought the statement here.
 */
export function liftLiterals(statement: string): { sql: string; values: Array<string | Uint8Array> } {
  const values: Array<string | Uint8Array> = [];
  let sql = '';
  let at = 0;
  for (;;) {
    const open = statement.indexOf("'", at);
    if (open === -1) break;
    let close = open + 1;
    for (;;) {
      close = statement.indexOf("'", close);
      if (close === -1) throw new Error('the dump holds a literal that never closes');
      if (statement[close + 1] === "'") {
        close += 2;
        continue;
      }
      break;
    }
    const blob = open > 0 && (statement[open - 1] === 'X' || statement[open - 1] === 'x');
    const body = statement.slice(open + 1, close);
    sql += `${statement.slice(at, blob ? open - 1 : open)}?${values.length + 1}`;
    values.push(blob ? hexBytes(body) : body.replace(/''/g, "'"));
    at = close + 1;
  }
  return { sql: sql + statement.slice(at), values };
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The comment lines a dump is read by, written by `lib/dump.ts` and read by the load's
 * owner check and the dry run (`lib/load.ts`). One place for both sides, so rewording
 * the file cannot leave a reader matching the old words and answering nothing.
 */
export const DUMP_LINES = {
  /** The first line: `${owner}${userId}, dumped ${time}`. */
  owner: '-- Unbent note store of account ',
  /** The last line when the store was not written to while it was read. */
  oneMoment: '-- Nothing was written while the store was read: the rows are one moment.',
  /** The last line when it was: the rows may be from either side of the write. */
  written: '-- The store was written to while it was read: rows read after the write may be from after it.',
} as const;

/** The first line of a dump: whose it is. */
export function dumpOwner(header: string): string | null {
  if (!header.startsWith(DUMP_LINES.owner)) return null;
  return /^(\S+), dumped /.exec(header.slice(DUMP_LINES.owner.length))?.[1] ?? null;
}

/**
 * What the object records in its key-value storage while a load is under way, and what
 * `stats` reports instead of counts. Written by `loadBegin` right after `deleteAll` and
 * removed by `loadFinish` as its last act, so a store that was emptied and not filled —
 * a load that failed, a Worker that died between pages — refuses every request until an
 * operator finishes a load or winds the store back, and is never read as whole.
 */
export interface LoadMarker {
  /** A fresh id per `loadBegin`; a page carrying another's is from a load that is over. */
  id: string;
  /** The dump's key in the backups bucket. */
  key: string;
  startedAt: number;
  pages: number;
  statements: number;
  /** The bookmark of the store before the first `loadBegin` of this load; null where the runtime keeps none. */
  undo: string | null;
  /** The key of the dump the route wrote before the first `loadBegin`; null when the route wrote none. */
  before: string | null;
}

/**
 * What a data method throws while a load is under way. `retryable` is an own property,
 * which is what `translateStoreError` turns into the 503 with `Retry-After` the Worker
 * answers for any passing unavailability, and what the sweep and the daily dumps defer
 * on — so the store is unavailable, in the one way the rest of the system already knows,
 * rather than empty.
 */
export class StoreLoading extends Error {
  readonly retryable = true;
  constructor(marker: LoadMarker) {
    super(`the store is being loaded from ${marker.key} (since ${new Date(marker.startedAt).toISOString()})`);
    this.name = 'StoreLoading';
  }
}

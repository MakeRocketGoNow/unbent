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
  const bare = head.replace(/'(?:[^']|'')*'/g, "''");
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
 * Whether a statement of the dump runs, is skipped, or refuses the whole load.
 *
 * Skipped: the `BEGIN` and `COMMIT` that wrap the file, since each page runs in a
 * transaction of the object's own and a nested `BEGIN` is an error; the two
 * `PRAGMA foreign_keys` lines, since a pragma inside a transaction does nothing and the
 * object turns foreign keys off around each page itself; and anything that is only
 * comments. Run: the `CREATE`s and `INSERT`s a dump is made of, and nothing else, so a
 * file that is not a dump — or a dump someone edited a `DROP` or `DELETE` into — stops
 * the load at its first such line rather than running it against the account.
 */
export function classify(statement: string): 'run' | 'skip' | 'refuse' {
  const head = statementText(statement);
  if (head === '' || head === ';') return 'skip';
  if (/^(BEGIN|COMMIT|END)\b/i.test(head)) return 'skip';
  if (/^PRAGMA\b/i.test(head)) return 'skip';
  if (/^(CREATE|INSERT)\b/i.test(head)) return 'run';
  return 'refuse';
}

/** The first line of a dump: whose it is. See `lib/dump.ts`, which writes it. */
export function dumpOwner(header: string): string | null {
  return /^-- Unbent note store of account (\S+), dumped /.exec(header)?.[1] ?? null;
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

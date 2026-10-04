/**
 * Turns arbitrary user input into a valid FTS5 MATCH expression.
 *
 * FTS5 query syntax is a real grammar: a stray quote, a bare `*`, or a reserved word like
 * `AND` raises a SQL error rather than returning nothing. Users type search boxes, not
 * query languages, so every term is quoted as a literal phrase and the last one gets a
 * prefix `*` so results appear while typing.
 *
 * Here rather than beside the server's statements because two engines read it: the
 * account's store on the server, and the index a device keeps for searching with no
 * connection (`apps/web/src/store/search-index.ts`). One box has to mean one query, and
 * a second copy of this would be the first place the two drifted.
 */
export function toFtsQuery(raw: string): string {
  const terms = raw
    .replace(/["*()]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (terms.length === 0) return '';

  return terms
    .map((term, i) => {
      const quoted = `"${term}"`;
      // Prefix-match only the final term: mid-query terms are complete words.
      return i === terms.length - 1 ? `${quoted}*` : quoted;
    })
    .join(' AND ');
}

/**
 * How every search index here splits and stems text. The server's four FTS5 tables are
 * declared with it (`store/schema/0001-init.ts`, which spells it out because a schema
 * file is never edited), and a device's local index must be too, or "running" would
 * find "run" with a connection and not without.
 */
export const FTS_TOKENIZE = 'porter unicode61 remove_diacritics 2';

/** The bm25 weights of a note's title against its body, on the server and on a device. */
export const NOTE_FTS_WEIGHTS = '10.0, 1.0';

/**
 * The arguments every search snippet is cut with, after the table and the column: the
 * marks around a match, which the client turns into `<mark>` rather than trusting HTML
 * from a note, the ellipsis, and the length in tokens. Shared for the reason the
 * tokenizer is: a match should read the same with and without a connection.
 */
export const SNIPPET_ARGS = "'<<', '>>', '…', 24";

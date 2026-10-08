/**
 * How a notebook's or a tag's name is told apart from another: as SQLite's `COLLATE
 * NOCASE` tells them apart, which is ASCII letters folded and nothing else.
 *
 * Both are unique without case in the store (`notebooks` from the start, `tags` since
 * MAK-127), so "Receipts" and "receipts" name one tag, and any code that decides by name
 * whether two are the same — the web app's local filters, a picker that adopts an
 * existing spelling, the store's own de-duplication of a tag list — has to fold exactly
 * as the index does. A fold that also lowered "É" or compared with `localeCompare` would
 * call two names one that the store keeps as two: "Café" and "CAFÉ" are two tags, as they
 * are two notebooks. Folding Unicode case as well was considered for MAK-127 and not
 * done: the index is what decides, and NOCASE is the collation SQLite has without ICU.
 *
 * Also about fifty times cheaper than `localeCompare` over an archive's rows.
 */
export const foldNoCase = (name: string): string => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Whether two names are one as the store's NOCASE index has it; see `foldNoCase`. */
export const sameName = (a: string, b: string): boolean => foldNoCase(a) === foldNoCase(b);

/**
 * The dates and amounts a document's text writes, found by pattern rather than by asking
 * a model.
 *
 * Two readers want them. Auto-fill offers them to Jev as the candidates a date or a
 * number field chooses from (`apps/api/src/lib/autofill.ts`), and the per-account store
 * names them in a text layer's one-line summary, so an assistant listing notes over MCP
 * sees a receipt's date and total without fetching its text (MAK-177). They lived in
 * auto-fill until the store needed them; the store imports nothing from the Worker's
 * `lib/`, so they moved here, where both can reach them and the two cannot drift.
 *
 * Each finding carries where it starts in the text (`index`), which neither caller had a
 * use for until the summary wanted its dates in the order the document writes them.
 */

/** A date the text writes: the day it means, and the words that said it. */
export interface FoundDate {
  /** `YYYY-MM-DD`. */
  iso: string;
  /** As written, trimmed. */
  raw: string;
  /** Where the first writing of this day starts in the text. */
  index: number;
}

/** A number the text writes that could be an amount. */
export interface FoundNumber {
  value: number;
  /** As written, trimmed: `$1,333.32`. */
  raw: string;
  /** Written with a currency mark or a fraction, which is what an amount usually has. */
  amount: boolean;
  index: number;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
/** `jan(?:uary)?|feb(?:ruary)?|…` — the abbreviation, with the rest of the name optional. */
const MONTH_NAME = MONTHS.map((m) => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join('|');

function monthNumber(name: string): number {
  return MONTHS.findIndex((m) => m.startsWith(name.slice(0, 3).toLowerCase())) + 1;
}

/** `YYYY-MM-DD` when the parts make a real date in a plausible century, else null. */
function isoDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Every date the text writes, in the four ways American documents write them: ISO,
 * numeric with slashes or dots, and the month by name on either side of the day. Numeric
 * dates are read month-first, as the archive's documents write them; a first number past
 * twelve can only be a day, so `25/3/2026` still reads.
 *
 * Once each day, in the order the patterns above are tried, not the order of the text —
 * auto-fill's candidates have always come this way. Sort by `index` for the text's order.
 */
export function findDates(text: string): FoundDate[] {
  const found = new Map<string, FoundDate>();
  const add = (iso: string | null, m: RegExpMatchArray) => {
    if (iso && !found.has(iso)) found.set(iso, { iso, raw: m[0].trim(), index: m.index ?? 0 });
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    add(isoDate(Number(m[1]), Number(m[2]), Number(m[3])), m);
  }
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    let year = Number(m[3]);
    if (m[3]!.length === 2) year += year < 70 ? 2000 : 1900;
    const [month, day] = a > 12 ? [b, a] : [a, b];
    add(isoDate(year, month, day), m);
  }
  const monthFirst = new RegExp(`\\b(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(monthFirst)) {
    add(isoDate(Number(m[3]), monthNumber(m[1]!), Number(m[2])), m);
  }
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME})\\.?,?\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(dayFirst)) {
    add(isoDate(Number(m[3]), monthNumber(m[2]!), Number(m[1])), m);
  }
  return [...found.values()];
}

/**
 * Every number the text writes that could be an amount: digits with optional thousands
 * separators and fraction, an optional sign, an optional currency mark. Anything glued
 * to a slash, dash, colon or letter is left alone — that is a date, a time, an id or a
 * phone number — and so is a run of more than nine digits, which is an account number.
 *
 * Once each value. Amounts (`amount`) come first, then the plain numbers, each in the
 * text's order, so a caller that keeps only the first few keeps the amounts.
 */
export function findNumbers(text: string): FoundNumber[] {
  const amounts: FoundNumber[] = [];
  const plain: FoundNumber[] = [];
  const seen = new Set<number>();
  const re = /(?<![\w./:-])(?:[$€£]\s?)?-?\d[\d,]*(?:\.\d+)?(?![\w/:-])/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0].trim();
    const marked = /^[$€£]/.test(raw);
    const digits = raw.replace(/^[$€£]\s?/, '').replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(digits)) continue;
    if (digits.replace(/^-/, '').split('.')[0]!.length > 9) continue;
    const value = Number(digits);
    if (!Number.isFinite(value) || seen.has(value)) continue;
    seen.add(value);
    const amount = marked || digits.includes('.');
    (amount ? amounts : plain).push({ value, raw, amount, index: m.index ?? 0 });
  }
  return [...amounts, ...plain];
}

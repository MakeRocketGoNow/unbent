import {
  MAX_FIELD_NAME_LENGTH,
  MAX_FIELD_VALUE_LENGTH,
  MAX_RATING_MAX,
  MAX_SELECT_OPTIONS,
  isReservedFieldName,
  type FieldValue,
  type NotebookFileField,
} from '@unbent/shared';

/**
 * What a Notion database's columns become here.
 *
 * Notion's CSV carries no types: a date, a select and a formula all arrive as text. So
 * each column's type is inferred from every value it holds across the rows, and the
 * inference is deliberately conservative — a column is a select only when its values
 * repeat, a multi-select only when its comma-separated parts do, and anything the rules
 * cannot place is text, which the notebook's Fields page can convert afterwards with the
 * confirmation that step deserves. Guessing wrong toward text loses nothing; guessing
 * wrong toward a stricter type would reject values.
 *
 * Some columns are not fields at all. The first is the title. One named Tags is the
 * note's tags, since that is what those were in every source this export was assembled
 * from. Notion's own created and last-edited stamps become the note's own dates, which
 * is the one place this export carries a timestamp. A column too long for a field —
 * a text property holding paragraphs — goes into the body under its own heading.
 */

export type NotionColumnKind = 'title' | 'field' | 'tags' | 'created' | 'updated' | 'body';

export interface NotionColumn {
  /** The header as Notion wrote it, which is also how a row page names the property. */
  source: string;
  /** The field's name here, when it becomes one. */
  name: string;
  kind: NotionColumnKind;
  /** The definition to create, for `kind: 'field'`. */
  field?: NotebookFileField;
}

export interface InferColumnsOptions {
  /** Whether a column named Tags becomes the note's tags rather than a field. Default true. */
  tagsAsTags?: boolean;
}

/** A Notion date as text: `August 2, 2026`, optionally with a time and a zone, or a range. */
const DATE_RE =
  /^([A-Za-z]+) (\d{1,2}), (\d{4})(?: (\d{1,2}):(\d{2}) (AM|PM))?(?: \([A-Z]{2,5}\))?(?: → .*)?$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export interface NotionDate {
  /** `YYYY-MM-DD`. A range keeps its start. */
  date: string;
  /** Present when Notion included a time of day. */
  time?: { hour: number; minute: number };
}

/** Reads a Notion date, or null for anything that is not one. */
export function parseNotionDate(raw: string): NotionDate | null {
  const text = raw.trim();
  const m = DATE_RE.exec(text);
  if (m) {
    const month = MONTHS.indexOf(m[1]!.toLowerCase());
    if (month < 0) return null;
    const day = Number(m[2]);
    const year = Number(m[3]);
    if (day < 1 || day > 31) return null;
    const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null;
    if (m[4] === undefined) return { date };
    let hour = Number(m[4]) % 12;
    if (m[6] === 'PM') hour += 12;
    return { date, time: { hour, minute: Number(m[5]) } };
  }
  const iso = ISO_DATE_RE.exec(text);
  if (iso) {
    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null;
    return iso[4] !== undefined
      ? { date, time: { hour: Number(iso[4]), minute: Number(iso[5]) } }
      : { date };
  }
  return null;
}

/**
 * A Notion date with a time, as epoch milliseconds in the importer's own zone.
 *
 * The export names no zone (one column style appends an abbreviation, which is not
 * enough to be sure of an offset), and the person importing is the person who wrote
 * the pages, so their clock is the best guess there is.
 */
export function notionTimestamp(raw: string): number | null {
  const d = parseNotionDate(raw);
  if (!d?.time) return null;
  const [y, m, day] = d.date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, day, d.time.hour, d.time.minute).getTime();
}

/** The currency a Notion number format writes its symbol as, by that symbol. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  US$: 'USD',
  CA$: 'CAD',
  A$: 'AUD',
  NZ$: 'NZD',
  MX$: 'MXN',
  HK$: 'HKD',
  S$: 'SGD',
  R$: 'BRL',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  'CN¥': 'CNY',
  '₹': 'INR',
  '₩': 'KRW',
  '₽': 'RUB',
  '₪': 'ILS',
  '฿': 'THB',
  '₫': 'VND',
  '₺': 'TRY',
  zł: 'PLN',
  kr: 'SEK',
  CHF: 'CHF',
  Fr: 'CHF',
};

export interface NotionNumber {
  value: number;
  /** An ISO 4217 code when the text carried a currency symbol or code. */
  currency?: string;
}

const NUMBER_RE = /^(-?)([^\d\s.,-]*|[A-Z]{3})\s?(-?)((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s?([^\d\s.,-]*|[A-Z]{3})$/;

/** Reads a Notion number — `22`, `1,234.5`, `-3`, `$29.99`, `€1.50`, `CHF 12` — or null. */
export function parseNotionNumber(raw: string): NotionNumber | null {
  const m = NUMBER_RE.exec(raw.trim());
  if (!m) return null;
  const negative = m[1] === '-' || m[3] === '-';
  const value = Number(m[4]!.replace(/,/g, '')) * (negative ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  const symbol = m[2] || m[5] || '';
  if (symbol === '') return { value };
  const currency = CURRENCY_SYMBOLS[symbol] ?? (/^[A-Z]{3}$/.test(symbol) ? symbol : undefined);
  return currency ? { value, currency } : null;
}

const STARS_RE = /^(?:★+|⭐+)$/u;

/** A rating drawn as a run of stars, as its count; null for anything else. */
export function starCount(raw: string): number | null {
  const text = raw.trim();
  return STARS_RE.test(text) ? [...text].length : null;
}

/** The parts of a multi-select value, as Notion joins them. */
export function atoms(raw: string): string[] {
  return raw
    .split(', ')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

const URL_RE = /^https?:\/\/\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{6,}$/;

/** Short enough to be a choice rather than a sentence. */
function isChoice(value: string): boolean {
  return value.length <= 40 && !/[.!?](\s|$)|\n/.test(value);
}

/** Every value that is not blank, once. */
function present(values: string[]): string[] {
  return values.map((v) => v.trim()).filter((v) => v.length > 0);
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * The name a column gets as a field: Notion's `userDefined:` prefix (its way of writing
 * a property that shares a built-in's name) dropped, a reserved name suffixed rather than
 * refused, and the length capped.
 */
export function fieldNameFor(source: string): string {
  let name = source.replace(/^userDefined:/, '').trim();
  if (isReservedFieldName(name)) name = `${name} (Notion)`;
  return name.slice(0, MAX_FIELD_NAME_LENGTH);
}

/** The types, in the order they are tried; the first whose rule every value passes wins. */
function inferField(name: string, values: string[]): NotebookFileField {
  if (values.length === 0) return { name, type: 'text' };

  if (values.every((v) => v === 'Yes' || v === 'No')) return { name, type: 'checkbox' };
  if (values.every((v) => parseNotionDate(v) !== null)) return { name, type: 'date' };

  const stars = values.map(starCount);
  if (stars.every((s) => s !== null)) {
    const longest = Math.max(...(stars as number[]));
    return {
      name,
      type: 'number',
      scale: { max: Math.min(MAX_RATING_MAX, Math.max(5, longest)), step: 1 },
    };
  }

  const numbers = values.map(parseNotionNumber);
  if (numbers.every((n) => n !== null)) {
    const currencies = distinct((numbers as NotionNumber[]).map((n) => n.currency ?? ''));
    if (currencies.length === 1) {
      const currency = currencies[0]!;
      return currency ? { name, type: 'number', currency } : { name, type: 'number' };
    }
    // Some with a symbol and some without, or two currencies: not one kind of number.
    return { name, type: 'text' };
  }

  if (values.every((v) => URL_RE.test(v))) return { name, type: 'url' };
  if (values.every((v) => EMAIL_RE.test(v))) return { name, type: 'email' };
  if (values.every((v) => PHONE_RE.test(v) && v.replace(/\D/g, '').length >= 6)) {
    return { name, type: 'phone' };
  }

  /*
     A multi-select is a column whose values split on ", " into short parts, at least one
     value into more than one, and the parts recurring across rows: at most half of them
     distinct. Recurrence is what tells "PC, PS5" from an address with commas in it, and
     the ratio is what keeps a column of addresses out even when the city and state
     repeat. A select is the same without the splitting: short values, at least a quarter
     of them repeats. Both keep their options in the order first seen.
  */
  const parts = values.map(atoms);
  const allShort = parts.every((ps) => ps.every(isChoice));
  if (allShort && parts.some((ps) => ps.length > 1)) {
    const all = parts.flat();
    const options = distinct(all);
    if (options.length * 2 <= all.length && options.length <= MAX_SELECT_OPTIONS) {
      return { name, type: 'multiselect', options };
    }
  }
  if (allShort && parts.every((ps) => ps.length === 1)) {
    const options = distinct(values);
    if (values.length >= 2 && options.length * 4 <= values.length * 3 && options.length <= MAX_SELECT_OPTIONS) {
      return { name, type: 'select', options };
    }
  }

  return { name, type: 'text' };
}

/**
 * The columns of a database, typed from its rows.
 *
 * `header` is the CSV's first row and `rows` the rest, each cell as text. Every column
 * comes back, in order, so the caller can walk a row page's properties by the names
 * Notion wrote.
 */
export function inferColumns(
  header: string[],
  rows: string[][],
  options: InferColumnsOptions = {},
): NotionColumn[] {
  const tagsAsTags = options.tagsAsTags ?? true;
  return header.map((source, i) => {
    if (i === 0) return { source, name: fieldNameFor(source), kind: 'title' };

    // Checked on Notion's name, before the reserved-name suffix would make it "Tags (Notion)".
    const isTags = source.replace(/^userDefined:/, '').trim().toLowerCase() === 'tags';
    if (tagsAsTags && isTags) return { source, name: 'Tags', kind: 'tags' };

    const name = fieldNameFor(source);
    const values = present(rows.map((r) => r[i] ?? ''));

    // Kept as a field, Tags is still a multi-select: that is the property Notion's own
    // templates give the name to, and its values are too varied for the repeat rule below.
    if (isTags) {
      const options = distinct(values.flatMap(atoms).filter((o) => o.length <= MAX_FIELD_NAME_LENGTH)).slice(
        0,
        MAX_SELECT_OPTIONS,
      );
      return { source, name, kind: 'field', field: { name, type: 'multiselect', options } };
    }

    // Notion's own stamps: every value carries a time of day, and the name says which.
    if (values.length > 0 && values.every((v) => notionTimestamp(v) !== null)) {
      if (/created|added/i.test(name)) return { source, name, kind: 'created' };
      if (/edited|updated|modified/i.test(name)) return { source, name, kind: 'updated' };
    }

    if (values.some((v) => v.length > MAX_FIELD_VALUE_LENGTH)) return { source, name, kind: 'body' };

    return { source, name, kind: 'field', field: inferField(name, values) };
  });
}

/**
 * A property's text as the value its field stores, or null for none.
 *
 * Reads by the field's type rather than re-inferring: a value the type cannot read — a
 * row page the CSV left out, holding something the rows never showed — comes back as
 * text where the type is text-like, and as null otherwise, so the note still lands and
 * the field is simply empty on it.
 */
export function convertValue(column: NotionColumn, raw: string): FieldValue | null {
  const text = raw.trim();
  if (text === '') return null;
  const field = column.field;
  if (!field) return null;
  switch (field.type) {
    case 'checkbox':
      return text === 'Yes' ? true : text === 'No' ? false : null;
    case 'date':
      return parseNotionDate(text)?.date ?? null;
    case 'number': {
      if (field.scale) return starCount(text);
      return parseNotionNumber(text)?.value ?? null;
    }
    case 'multiselect':
      return atoms(text);
    case 'select':
    case 'url':
    case 'email':
    case 'phone':
    case 'text':
      return text.slice(0, MAX_FIELD_VALUE_LENGTH);
  }
}

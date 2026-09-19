/**
 * Custom fields: the types a notebook can define, and how a value of each type is read,
 * stored and written back out.
 *
 * Everything about a value's *meaning* lives here, so the API route, the MCP tool, the
 * import path and the export codec cannot disagree about what "a number" is. The database
 * stores every value as canonical text plus a numeric shadow (see migration 0014); this
 * module is the only place that produces or reads those two columns.
 */
import { z } from 'zod';
import { dateOnlySchema, startOfDay, endOfDay } from './dates.js';

export const FIELD_TYPES = [
  'text',
  'number',
  'date',
  'checkbox',
  'url',
  'email',
  'phone',
  'select',
  'multiselect',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const fieldTypeSchema = z.enum(FIELD_TYPES);

/** How each type is named to a person, in the type picker and in error messages. */
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  checkbox: 'Checkbox',
  url: 'URL',
  email: 'Email',
  phone: 'Phone',
  select: 'Select',
  multiselect: 'Multi-select',
};

/**
 * Whether a type's definition carries an option list.
 *
 * A select and a multi-select are the same list of choices; they differ in how many of
 * them a note may hold. Everything that treats options as "a select's" — the column
 * that stores them, the editor that edits them, the definitions file that carries them,
 * the seeding when a field is converted — asks this rather than naming the types, so the
 * two cannot drift apart on which fields have options.
 */
export function fieldHasOptions(type: FieldType): boolean {
  return type === 'select' || type === 'multiselect';
}

/**
 * Frontmatter keys the exporter itself writes. A field may not take one of these names,
 * case-insensitively, because export would then emit the key twice and a reader would keep
 * whichever came last. `body` is not a frontmatter key, but it is what the note's text is
 * called everywhere a note is handed to a program, so it is kept out of the way too.
 *
 * Obsidian's own special keys (`aliases`, `cssclasses`) are deliberately not reserved:
 * a person who names a field that way in Obsidian means it.
 */
export const RESERVED_FIELD_NAMES = [
  'id',
  'title',
  'created',
  'updated',
  'tags',
  'notebook',
  'source',
  'body',
] as const;

export function isReservedFieldName(name: string): boolean {
  return (RESERVED_FIELD_NAMES as readonly string[]).includes(name.trim().toLowerCase());
}

export const MAX_FIELD_NAME_LENGTH = 100;
export const MAX_FIELD_VALUE_LENGTH = 1000;
export const MAX_FIELDS_PER_NOTEBOOK = 50;
export const MAX_SELECT_OPTIONS = 100;

/**
 * A rating: a `number` field that carries a scale.
 *
 * A rating is not its own type, because under the storage model it already *is* a number.
 * `encodeFieldValue` gives it the same `{text, num}`, `fieldSortsNumerically` already
 * orders it, and `gte`/`lte` already compare its numeric shadow — so "rated 4 and up" is a
 * filter that exists before this feature does. What a rating adds is a bound and a step,
 * which a plain number has neither of. A second type would have duplicated the encode,
 * sort, filter, export and import paths to gain nothing, and would have made "5 instead of
 * 10" a destructive type conversion (see `planConversion`) rather than an edit to a field.
 *
 * The scale lives in its own column rather than in `options`: that is a JSON array of
 * strings which `optionsColumn` nulls for every type but `select`, and which
 * `planConversion` seeds from existing values when converting *to* select. A max smuggled
 * in there would come back out as a select option.
 *
 * Ratings run from 1, not 0. Zero and "no value" both draw as an unlit row, while the
 * storage genuinely separates them — `encodeFieldValue` turns an empty string into
 * `'clear'`. Starting at 1 keeps an unlit row meaning exactly one thing, so `set`/`empty`
 * stay honest and the stars need no rival clear affordance beside them.
 */
export const MIN_RATING_MAX = 2;
export const MAX_RATING_MAX = 10;

/**
 * Half steps buy ten levels of granularity inside five glyphs, which is what Letterboxd,
 * Goodreads and most five-star product ratings do. A half is exactly representable and
 * lands on half a glyph with nothing to round, so the renderer never has to interpret it;
 * a value off the step is refused at encode time instead, where the message can say why.
 */
export const RATING_STEPS = [1, 0.5] as const;
export type RatingStep = (typeof RATING_STEPS)[number];

/** A `number` field's scale. Absent on a plain number, which stays unbounded. */
export interface FieldScale {
  /** The top of the scale; a rating runs 1..max. */
  max: number;
  /** `0.5` when half steps are allowed, `1` for whole steps only. */
  step: RatingStep;
}

export const fieldScaleSchema = z.object({
  max: z.number().int().min(MIN_RATING_MAX).max(MAX_RATING_MAX),
  step: z.union([z.literal(1), z.literal(0.5)]),
});

/**
 * A `number` field's currency: an ISO 4217 code, which is what `Intl.NumberFormat` takes.
 *
 * A currency is not a type, for the reason a rating is not one: the value is a number,
 * and is stored, sorted, ranged and exported as one. What a currency adds is how the
 * number is drawn — `$29.99` rather than `29.99` — so it is a column on the definition
 * beside the scale. The two are exclusive: a rating is not an amount of money, and the
 * schemas below refuse both at once.
 *
 * Only the shape is checked. `Intl` formats any well-formed code, an unknown one as the
 * code beside the number, so a currency the picker does not list still reads.
 */
export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'expected an ISO 4217 currency code such as USD');

/** The codes the picker offers first. Any well-formed code is accepted; these are the common ones. */
export const CURRENCY_CODES = [
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'JPY',
  'CHF',
  'MXN',
  'INR',
  'CNY',
  'SEK',
  'NZD',
] as const;

/**
 * Whether a field draws its number as money: a `number` with a currency and no scale.
 *
 * The one place that answers it, as `isRatingField` is for stars, so the glyph, the
 * property row's affix and a list cell cannot disagree about which numbers are amounts.
 */
export function isCurrencyField(def: {
  type: FieldType;
  scale?: FieldScale | null;
  currency?: string | null;
}): boolean {
  return def.type === 'number' && !def.scale && typeof def.currency === 'string' && def.currency !== '';
}

/**
 * How wide a row of stars may get before the value is drawn as text instead.
 *
 * Five glyphs is a comfortable row of tap targets; ten is not, and ten of them in a
 * property row repeats the failure that turned `NoteFields` from boxed inputs into a
 * property list. Above five, the value reads as `7/10` — honest, compact, and sorting
 * identically. Half steps are what keep this rare rather than limiting: max 5 with halves
 * already offers ten levels.
 */
export const MAX_STAR_GLYPHS = 5;

export function ratingRendersAsStars(scale: FieldScale): boolean {
  return scale.max <= MAX_STAR_GLYPHS;
}

/**
 * Whether a field is a rating: a `number` carrying a scale.
 *
 * The one place that answers it, so a renderer, a filter chip and a column header cannot
 * disagree about which numbers get stars.
 */
export function isRatingField(def: Pick<FieldDef, 'type' | 'scale'>): boolean {
  return def.type === 'number' && def.scale !== null;
}

/** The values a scale allows, low to high: 1, 1.5, 2 … max. */
export function ratingSteps(scale: FieldScale): number[] {
  const out: number[] = [];
  // Halves are exact in binary floating point, so accumulating needs no rounding guard.
  for (let v = 1; v <= scale.max; v += scale.step) out.push(v);
  return out;
}

export const fieldNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_FIELD_NAME_LENGTH)
  .refine((n) => !isReservedFieldName(n), 'That name belongs to the note itself');

/** Select options: trimmed, non-empty, and de-duplicated in the order given. */
export const fieldOptionsSchema = z
  .array(z.string().trim().min(1).max(MAX_FIELD_NAME_LENGTH))
  .max(MAX_SELECT_OPTIONS)
  .transform((opts) => [...new Set(opts)]);

const NOT_BOTH = { message: 'A rating cannot also be a currency', path: ['currency'] };

export const createFieldSchema = z
  .object({
    name: fieldNameSchema,
    type: fieldTypeSchema,
    options: fieldOptionsSchema.default([]),
    scale: fieldScaleSchema.nullish(),
    currency: currencySchema.nullish(),
  })
  .refine((f) => !(f.scale && f.currency), NOT_BOTH);

/**
 * `scale: null` clears one, which is how a rating becomes a plain number again; `currency:
 * null` likewise. Absent leaves either alone, matching how `name`, `type` and `options`
 * patch. A patch may not set both, and the repo drops a currency when a scale stands.
 */
export const updateFieldSchema = z
  .object({
    name: fieldNameSchema.optional(),
    type: fieldTypeSchema.optional(),
    options: fieldOptionsSchema.optional(),
    scale: fieldScaleSchema.nullish(),
    currency: currencySchema.nullish(),
  })
  .refine((f) => !(f.scale && f.currency), NOT_BOTH);

export const reorderFieldsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MAX_FIELDS_PER_NOTEBOOK),
});

export type CreateFieldInput = z.infer<typeof createFieldSchema>;
export type UpdateFieldInput = z.infer<typeof updateFieldSchema>;

/**
 * A value as a program sees it: what the API accepts and what export writes to YAML.
 *
 * A list is a multi-select's value — its chosen options, each a string. It is the one
 * non-scalar, and it is a plain list rather than a joined string so that an option can
 * contain a comma and a YAML reader sees a sequence, the way it sees `tags`.
 */
export type FieldValue = string | number | boolean | string[];

export const fieldValueInputSchema = z.union([
  z.string().max(MAX_FIELD_VALUE_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(MAX_FIELD_VALUE_LENGTH)).max(MAX_SELECT_OPTIONS),
]);

/**
 * Values on a note, keyed by field id. `null` clears one. Merge semantics: keys absent
 * from the patch are left alone, so a caller setting one field does not have to know
 * the rest — see `NotesRepo.setNoteFields`.
 */
export const noteFieldsPatchSchema = z.record(z.string().uuid(), fieldValueInputSchema.nullable());
export type NoteFieldsPatch = z.infer<typeof noteFieldsPatchSchema>;

/** A field definition as the API reports it. */
export interface FieldDef {
  id: string;
  notebookId: string;
  name: string;
  type: FieldType;
  /** Empty for every type but `select` and `multiselect`; see `fieldHasOptions`. */
  options: string[];
  /** Set only on a `number` that is a rating; null on every other field. */
  scale: FieldScale | null;
  /** Set only on a `number` drawn as money; null on every other field. See `isCurrencyField`. */
  currency: string | null;
  position: number;
  /** How many notes hold a value. Present only on the management listing. */
  valueCount?: number;
}

/**
 * A value as it rides on a note, with enough of its definition to render without a second
 * request, and enough of its notebook to say when the field belongs to a notebook the note
 * is no longer in.
 */
export interface NoteFieldValue {
  fieldId: string;
  name: string;
  type: FieldType;
  value: FieldValue;
  /**
   * The scale, when the field is a rating. Here for the same reason `type` is: a list row
   * draws `★★★★☆` rather than `4`, and without the scale it could not know how many
   * glyphs the row has — or that the number is a rating at all.
   */
  scale?: FieldScale | null;
  /** The currency, when the field has one, for the same reason `scale` rides here: a row draws `$12.50`, not `12.5`. */
  currency?: string | null;
  notebookId: string;
  notebook: string;
}

/** The two columns a value is stored as. */
export interface EncodedFieldValue {
  text: string;
  num: number | null;
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * Read a value under a type. Returns the stored form, `'clear'` for an empty string (an
 * emptied input means "no value", never "the empty string"), or `null` when the value
 * cannot be read as this type — the caller turns that into a message with
 * `expectedFieldValue`.
 */
export function encodeFieldValue(
  def: Pick<FieldDef, 'type' | 'options'> & Partial<Pick<FieldDef, 'scale'>>,
  value: FieldValue,
): EncodedFieldValue | 'clear' | null {
  if (typeof value === 'string' && value.trim() === '') return 'clear';

  switch (def.type) {
    case 'text':
    case 'phone': {
      const text = String(value).trim();
      return text.length > MAX_FIELD_VALUE_LENGTH ? null : { text, num: null };
    }
    case 'url': {
      if (typeof value !== 'string') return null;
      const text = value.trim();
      // zod's url check rather than `new URL`: this package has no DOM lib, and the
      // protocol option says http(s) in one place instead of a try/catch and a compare.
      return z.url({ protocol: /^https?$/ }).safeParse(text).success ? { text, num: null } : null;
    }
    case 'email': {
      if (typeof value !== 'string') return null;
      const text = value.trim();
      return z.email().safeParse(text).success ? { text, num: null } : null;
    }
    case 'number': {
      let n: number;
      if (typeof value === 'number') n = value;
      else if (typeof value === 'string' && NUMBER_RE.test(value.trim())) n = Number(value.trim());
      else return null;
      if (!Number.isFinite(n)) return null;
      // A scale bounds the number and quantises it. Enforced here rather than in the star
      // control, so a value arriving from the API, MCP or an import is held to the same
      // scale as one set by tapping — the module's whole reason for existing.
      if (def.scale) {
        if (n < 1 || n > def.scale.max) return null;
        // Scaled to integers before the remainder: `3.3 % 0.5` is not 0 in floating point.
        if ((n * 2) % (def.scale.step * 2) !== 0) return null;
      }
      return { text: String(n), num: n };
    }
    case 'date': {
      if (typeof value !== 'string') return null;
      const text = value.trim();
      if (!dateOnlySchema.safeParse(text).success) return null;
      return { text, num: startOfDay(text) };
    }
    case 'checkbox': {
      let b: boolean;
      if (typeof value === 'boolean') b = value;
      else if (value === 'true' || value === 'false') b = value === 'true';
      else return null;
      return { text: String(b), num: b ? 1 : 0 };
    }
    case 'select': {
      if (typeof value !== 'string') return null;
      const text = value.trim();
      return def.options.includes(text) ? { text, num: null } : null;
    }
    case 'multiselect': {
      /*
         A list of options, or one option as a bare string — which is what a select's
         value looks like, so converting a select to a multi-select carries every value
         across. An empty list clears, the way an emptied input does.

         Stored as a JSON array in the text column, in the option list's own order with
         each option at most once. Canonical order is what makes "unchanged" a string
         comparison and the export deterministic; JSON rather than a joined string is what
         lets an option contain a comma and the filter read the list back exactly.
      */
      const given = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null;
      if (given === null) return null;
      const picked = new Set(given.map((v) => String(v).trim()).filter((v) => v.length > 0));
      if (picked.size === 0) return 'clear';
      for (const v of picked) if (!def.options.includes(v)) return null;
      const list = def.options.filter((o) => picked.has(o));
      return { text: JSON.stringify(list), num: null };
    }
  }
}

// --- Filtering by a field ------------------------------------------------------------

/**
 * The comparisons a list can be narrowed by, on one field.
 *
 * `eq` compares the stored text — a select's option, a checkbox's `true`/`false`, a date
 * as written. `gte`/`lte` compare the numeric shadow that migration 0014 keeps for every
 * number and date, so a range never has to parse text in SQL. `set`/`empty` ask whether
 * the note holds a value at all, which for a record-like notebook — "coupons with no
 * expiry" — is the question asked most.
 *
 * Text "contains" is deliberately not here: search already covers field values, and a
 * substring filter would be a second, worse search box.
 */
export const FIELD_FILTER_OPS = ['eq', 'gte', 'lte', 'set', 'empty'] as const;
export type FieldFilterOp = (typeof FIELD_FILTER_OPS)[number];

export interface FieldFilter {
  fieldId: string;
  op: FieldFilterOp;
  /** Present for `eq`, `gte` and `lte`; absent for `set` and `empty`. */
  value?: string;
}

/** Field ids are UUIDs, which is what lets the wire form below use `:` unescaped. */
const FIELD_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * One field filter as it travels in a URL: `<fieldId>:<op>` or `<fieldId>:<op>:<value>`.
 *
 * The id and the op can contain no `:`, so the first two are the separators and the value
 * is everything after them, whatever it contains — a select option with a colon in it is
 * fine. Repeated `field=` params carry several, ANDed, the way `tag=` does. Returns null
 * for anything unreadable: a bad id, an unknown op, a missing or over-long value, or a
 * range bound that is neither a number nor a date.
 */
export function parseFieldFilter(raw: string): FieldFilter | null {
  const a = raw.indexOf(':');
  if (a < 0) return null;
  const fieldId = raw.slice(0, a);
  if (!FIELD_ID_RE.test(fieldId)) return null;
  const rest = raw.slice(a + 1);
  const b = rest.indexOf(':');
  const op = b < 0 ? rest : rest.slice(0, b);
  if (!(FIELD_FILTER_OPS as readonly string[]).includes(op)) return null;
  if (op === 'set' || op === 'empty') return b < 0 ? { fieldId, op } : null;
  if (b < 0) return null;
  const value = rest.slice(b + 1);
  if (value === '' || value.length > MAX_FIELD_VALUE_LENGTH) return null;
  if ((op === 'gte' || op === 'lte') && fieldRangeBound(op, value) === null) return null;
  return { fieldId, op: op as FieldFilterOp, value };
}

export function formatFieldFilter(f: FieldFilter): string {
  return f.value === undefined ? `${f.fieldId}:${f.op}` : `${f.fieldId}:${f.op}:${f.value}`;
}

/**
 * The number a range bound compares against `value_num`.
 *
 * A date bound is a day, and a day has two ends: "on or after the 10th" starts at its
 * first instant and "on or before the 10th" runs to its last, which is what `startOfDay`
 * and `endOfDay` are for. A number is itself. Anything else is not a bound.
 */
export function fieldRangeBound(op: 'gte' | 'lte', value: string): number | null {
  if (dateOnlySchema.safeParse(value).success) {
    return op === 'gte' ? startOfDay(value) : endOfDay(value);
  }
  if (NUMBER_RE.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// --- Sorting by a field --------------------------------------------------------------

/**
 * Whether a type orders by its numeric shadow rather than its text.
 *
 * Numbers, dates and checkboxes all store a `value_num` (see `encodeFieldValue`), and it
 * is the column that puts 9 before 10 and March before April. Every other type is text and
 * orders as text. The API's ORDER BY and the cursor it pages with both ask this, so the
 * column that sorted a page is the column that resumes it.
 */
export function fieldSortsNumerically(type: FieldType): boolean {
  return type === 'number' || type === 'date' || type === 'checkbox';
}

/**
 * The value the API sorted a row by, as it rides on the row: the numeric shadow for a
 * numeric type, the text otherwise, or `''` when the note holds no value for the field.
 *
 * This is what the keyset cursor carries for a field sort. `''` is unambiguous as the
 * "no value" marker because a stored text is never empty — `encodeFieldValue` turns an
 * empty string into a clear rather than a value. Deliberately not `encodeFieldValue`: a
 * select option retired after the note stored it would come back `null` from that, and a
 * row the API just returned under that value still has to page past it.
 */
export function fieldSortKey(
  def: Pick<FieldDef, 'id' | 'type'>,
  fields: readonly NoteFieldValue[] | undefined,
): string | number {
  const held = fields?.find((f) => f.fieldId === def.id);
  if (!held) return '';
  switch (def.type) {
    case 'number': {
      const n = typeof held.value === 'number' ? held.value : Number(held.value);
      return Number.isFinite(n) ? n : '';
    }
    case 'date':
      return startOfDay(String(held.value));
    case 'checkbox':
      return held.value === true ? 1 : 0;
    case 'multiselect':
      // The stored text is the JSON list, and that is what the SQL ordered by.
      return JSON.stringify(Array.isArray(held.value) ? held.value : [String(held.value)]);
    default:
      return String(held.value);
  }
}

/**
 * The definition with the options a note already holds put back, for reading that note's
 * next value.
 *
 * Options can shrink without converting the field. The editor keeps a retired value on
 * notes that already hold it ("Travel (no longer an option)"), and it resends every field
 * on every save. Rejecting that resend would fail the whole patch — title and body
 * included — until someone cleared the value by hand. So a retired option the note holds
 * stays legal for that note: for a select that is the one stored option, for a
 * multi-select each option in the stored list. A multi-select in particular needs this
 * to be a widening rather than an "unchanged, skip" check, because adding a live option
 * beside a retired one is a real edit that has to write. An option the note does not
 * already hold is a new choice and still has to be in the list.
 */
export function withHeldOptions<D extends Pick<FieldDef, 'type' | 'options'>>(
  def: D,
  storedText: string | undefined,
): D {
  if (storedText === undefined || !fieldHasOptions(def.type)) return def;
  const held = def.type === 'select' ? [storedText] : (decodeFieldValue('multiselect', storedText) as string[]);
  const retired = held.filter((o) => !def.options.includes(o));
  return retired.length === 0 ? def : { ...def, options: [...def.options, ...retired] };
}

/** What a rejected value should have looked like, for an error message. */
export function expectedFieldValue(
  def: Pick<FieldDef, 'type' | 'options'> & Partial<Pick<FieldDef, 'scale'>>,
): string {
  switch (def.type) {
    case 'number':
      if (def.scale) {
        return def.scale.step === 0.5
          ? `must be a rating from 1 to ${def.scale.max}, in halves`
          : `must be a whole rating from 1 to ${def.scale.max}`;
      }
      return 'must be a number';
    case 'date':
      return 'must be a date written YYYY-MM-DD';
    case 'checkbox':
      return 'must be true or false';
    case 'url':
      return 'must be a web address starting with http:// or https://';
    case 'email':
      return 'must be an email address';
    case 'select':
      return def.options.length
        ? `must be one of: ${def.options.join(', ')}`
        : 'has no options to choose from yet';
    case 'multiselect':
      return def.options.length
        ? `must be a list of options from: ${def.options.join(', ')}`
        : 'has no options to choose from yet';
    case 'text':
    case 'phone':
      return `must be at most ${MAX_FIELD_VALUE_LENGTH} characters`;
  }
}

/** The stored text back to a typed value. */
export function decodeFieldValue(type: FieldType, text: string): FieldValue {
  switch (type) {
    case 'number': {
      const n = Number(text);
      return Number.isFinite(n) ? n : text;
    }
    case 'checkbox':
      return text === 'true';
    case 'multiselect': {
      // The JSON list `encodeFieldValue` wrote. Anything else is read as one option, so a
      // row written under another type and converted without a plan still reads.
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) return parsed;
      } catch {
        // Not JSON: fall through.
      }
      return [text];
    }
    default:
      return text;
  }
}

/**
 * The type a value arriving without a definition should create: a boolean is a checkbox,
 * a number a number, a `YYYY-MM-DD` string a date, and anything else text. Nothing more
 * adventurous — guessing "url" from a string that starts with http would make the field
 * reject the next value that does not.
 */
export function inferFieldType(value: FieldValue): FieldType {
  if (Array.isArray(value)) return 'multiselect';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (dateOnlySchema.safeParse(value).success) return 'date';
  return 'text';
}

export interface ConversionPlan<R> {
  /** Rows that survive, with their new stored form. */
  keep: Array<{ row: R; text: string; num: number | null }>;
  /** Rows that cannot be read under the new type and will be cleared. */
  drop: R[];
  /** Set when converting to `select`: the distinct existing values become the options. */
  seededOptions?: string[];
}

/**
 * What changing a field's type — or a rating's scale — does to its existing values.
 *
 * Shared by the preview (so the confirmation can name how many values would be cleared)
 * and by the write, so the two cannot disagree. Converting *to* select never clears:
 * the values a field already holds are the obvious option list, so they become it.
 *
 * `toScale` is why a scale is an edit rather than a type change. Widening 5 to 10 keeps
 * every value, because a rating legal on the old scale is legal on the wider one. Narrowing
 * 10 to 5, or dropping half steps, cannot keep a 7 or a 3.5 — those land in `drop` and are
 * counted in the same confirmation that a type change gets, instead of being silently
 * rewritten to something the person never chose.
 */
export function planConversion<R extends { text: string }>(
  from: FieldType,
  to: FieldType,
  rows: R[],
  toScale?: FieldScale | null,
): ConversionPlan<R> {
  const plan: ConversionPlan<R> = { keep: [], drop: [] };
  const decoded = rows.map((row) => ({ row, value: decodeFieldValue(from, row.text) }));

  /*
     Seeded from what the rows hold, one option per distinct value. A multi-select's rows
     are lists, so it is their elements that become options — both when a multi-select is
     becoming a select and when a select is becoming a multi-select, where every value
     carries across as a one-element list.
  */
  let options: string[] = [];
  if (fieldHasOptions(to)) {
    const seen = new Set<string>();
    for (const { value } of decoded) {
      for (const v of Array.isArray(value) ? value : [String(value)]) {
        const t = v.trim();
        if (t.length > 0) seen.add(t);
      }
    }
    options = [...seen].slice(0, MAX_SELECT_OPTIONS);
    plan.seededOptions = options;
  }

  for (const { row, value } of decoded) {
    /*
       A list leaving the multi-select type: text takes the options joined, since that is
       the printed form and nothing is lost; a select takes a list of one, since that is
       a choice; anything else cannot read a list and drops it, the same as a number
       cannot read a word.
    */
    const candidate =
      Array.isArray(value) && to !== 'multiselect'
        ? to === 'text'
          ? value.join(', ')
          : value.length === 1
            ? value[0]!
            : value
        : value;
    const encoded = encodeFieldValue({ type: to, options, scale: toScale ?? null }, candidate);
    if (encoded === null || encoded === 'clear') plan.drop.push(row);
    else plan.keep.push({ row, text: encoded.text, num: encoded.num });
  }
  return plan;
}

/**
 * A note's values keyed by field name, the shape frontmatter and MCP output use.
 *
 * A note can carry values for fields of a notebook it has since left, and two notebooks
 * may each define "Vendor". The note's own notebook wins the bare name; a foreign field
 * whose name is taken is keyed `Name (Notebook)` so nothing is silently dropped.
 */
export function fieldsByName(
  values: NoteFieldValue[],
  ownNotebookId: string | null,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  const taken = new Set<string>();
  const claim = (name: string, value: FieldValue) => {
    out[name] = value;
    taken.add(name.toLowerCase());
  };

  for (const v of values) if (v.notebookId === ownNotebookId) claim(v.name, v.value);
  for (const v of values) {
    if (v.notebookId === ownNotebookId) continue;
    claim(taken.has(v.name.toLowerCase()) ? `${v.name} (${v.notebook})` : v.name, v.value);
  }
  return out;
}

/** A value that cannot be stored under its field's type. Carries the name for the message. */
export class InvalidFieldValue extends Error {
  constructor(
    readonly fieldName: string,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidFieldValue';
  }
}

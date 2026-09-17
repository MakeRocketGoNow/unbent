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
};

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

export const createFieldSchema = z.object({
  name: fieldNameSchema,
  type: fieldTypeSchema,
  options: fieldOptionsSchema.default([]),
});

export const updateFieldSchema = z.object({
  name: fieldNameSchema.optional(),
  type: fieldTypeSchema.optional(),
  options: fieldOptionsSchema.optional(),
});

export const reorderFieldsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MAX_FIELDS_PER_NOTEBOOK),
});

export type CreateFieldInput = z.infer<typeof createFieldSchema>;
export type UpdateFieldInput = z.infer<typeof updateFieldSchema>;

/** A value as a program sees it: what the API accepts and what export writes to YAML. */
export type FieldValue = string | number | boolean;

export const fieldValueInputSchema = z.union([
  z.string().max(MAX_FIELD_VALUE_LENGTH),
  z.number().finite(),
  z.boolean(),
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
  /** Empty for every type but `select`. */
  options: string[];
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
  def: Pick<FieldDef, 'type' | 'options'>,
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
    default:
      return String(held.value);
  }
}

/**
 * Whether a select value that `encodeFieldValue` rejected should still be left on the note.
 *
 * Select options can shrink without converting the field. The editor keeps a retired
 * value on notes that already hold it ("Travel (no longer an option)"), and it resends
 * every field on every save. Rejecting that resend fails the whole patch — title and
 * body included — until someone clears the value by hand. A value the note does not
 * already hold is a new choice and still has to be in the list.
 */
export function isHeldSelectValue(
  def: Pick<FieldDef, 'type'>,
  value: FieldValue | null | undefined,
  storedText: string | undefined,
): boolean {
  if (def.type !== 'select' || storedText === undefined || typeof value !== 'string') return false;
  // Re-trims rather than reusing encodeFieldValue's trimmed text: this runs only after
  // encodeFieldValue has already rejected the value, so its `text` isn't in scope here.
  return value.trim() === storedText;
}

/** What a rejected value should have looked like, for an error message. */
export function expectedFieldValue(def: Pick<FieldDef, 'type' | 'options'>): string {
  switch (def.type) {
    case 'number':
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
 * What changing a field's type does to its existing values.
 *
 * Shared by the preview (so the confirmation can name how many values would be cleared)
 * and by the write, so the two cannot disagree. Converting *to* select never clears:
 * the values a field already holds are the obvious option list, so they become it.
 */
export function planConversion<R extends { text: string }>(
  from: FieldType,
  to: FieldType,
  rows: R[],
): ConversionPlan<R> {
  const plan: ConversionPlan<R> = { keep: [], drop: [] };

  let options: string[] = [];
  if (to === 'select') {
    options = [...new Set(rows.map((r) => r.text.trim()).filter((t) => t.length > 0))].slice(
      0,
      MAX_SELECT_OPTIONS,
    );
    plan.seededOptions = options;
  }

  for (const row of rows) {
    const encoded = encodeFieldValue({ type: to, options }, decodeFieldValue(from, row.text));
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

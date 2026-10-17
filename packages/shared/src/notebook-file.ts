/**
 * The notebook definitions file, the part of the export that is about a notebook rather
 * than a note.
 *
 * A note's markdown carries its field *values* as frontmatter keys by name, and that is
 * all it can carry: a value says nothing about whether its field is a URL or a select, what
 * the select's options are, how tall a rating's scale is, or that a field with no values
 * exists at all. Import used to rebuild every definition from the first value it met, and
 * the result was a notebook whose URLs, selects and ratings had all become Text and
 * Number, with an empty field gone entirely. The values survived; their meaning did not.
 *
 * So the archive carries one `notebooks/<slug>.yaml` per notebook in scope, holding what
 * the notebook's own settings page shows: its name, its emoji and its purpose when it has
 * them, and its fields in order, each with its type and, where it has them, its options or
 * scale. Import reads these before any note, so values land against typed definitions
 * instead of guesses.
 *
 * The emoji and the purpose came later, and a restore lost both until they did: the
 * notebooks came back as plain books, and Auto-fill, which reads the purpose to decide what
 * belongs where, filed differently than it had on the instance the export came from.
 *
 * YAML rather than JSON, and it was a close call. JSON is what a program would pick; but
 * every other file in the archive is markdown with YAML frontmatter, the parser is already
 * a dependency for that, and a person opening the zip to see what is in it should meet one
 * syntax, not two. Field order is the list order, which both formats keep.
 *
 * A definition file is deliberately not a manifest. It says what a notebook is, not what
 * the archive contains: the walker still finds notes by their own layout, and an archive
 * with no `notebooks/` directory (an older export, a hand-made vault) reads exactly as it
 * did before, with types inferred.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import {
  MAX_FIELDS_PER_NOTEBOOK,
  MAX_FIELD_NAME_LENGTH,
  currencySchema,
  fieldHasOptions,
  fieldNameSchema,
  fieldOptionsSchema,
  fieldScaleSchema,
  fieldTypeSchema,
  type FieldDef,
  type FieldScale,
  type FieldType,
} from './fields.js';
import { notebookEmojiSchema, notebookNameSchema, notebookPurposeSchema } from './schemas.js';
import { colorName, parseColorName } from './colors.js';

/** One field as the file describes it. No id: ids never leave the database's world. */
export interface NotebookFileField {
  name: string;
  type: FieldType;
  /** Present only on a `select` or a `multiselect`. */
  options?: string[];
  /**
   * Each option's colour, by name, as an index into the palette. Written beside the
   * options rather than inside them, so `options` stays the list of words every other
   * reader of this file expects; in the file the value is the colour's name (`green`),
   * which a person can read and write, and the index is accepted too.
   */
  optionColors?: Record<string, number>;
  /** Present only on a rating. */
  scale?: FieldScale;
  /** Present only on a number drawn as money. */
  currency?: string;
}

/** A notebook as the file describes it: its name, its look and purpose, its fields in order. */
export interface NotebookDefinition {
  name: string;
  /** Drawn in place of the book. Absent, or null, when the notebook has none. */
  emoji?: string | null;
  /** The sentence Auto-fill reads to decide what belongs here. Absent, or null, when unset. */
  purpose?: string | null;
  fields: NotebookFileField[];
}

/**
 * The file's shape, which is also what the import endpoint accepts.
 *
 * Strict where the field editor is strict (reserved names, the option cap, the rating
 * bounds) because a file that fails here was written by hand, not by the export, and a
 * clear refusal beats a definition that half-applies. The emoji and the purpose go through
 * the same schemas the notebook's settings page saves through, so a file cannot put an icon
 * or a sentence on a notebook that the picker or the purpose editor would have refused.
 */
/**
 * `colors:` in the file: option to colour name or index. A name the palette does not have
 * is refused by name, as any other hand-written mistake in the file is.
 */
const optionColorFileSchema = z
  .record(
    z.string().min(1).max(MAX_FIELD_NAME_LENGTH),
    z.union([z.string(), z.number()]).transform((v, ctx) => {
      const index = parseColorName(v);
      if (index === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Not a colour: ${String(v)}` });
        return z.NEVER;
      }
      return index;
    }),
  )
  .transform((colors) => colors as Record<string, number>);

export const notebookDefinitionSchema = z.object({
  name: notebookNameSchema,
  emoji: notebookEmojiSchema.optional(),
  purpose: notebookPurposeSchema.optional(),
  fields: z
    .array(
      z.object({
        name: fieldNameSchema,
        type: fieldTypeSchema,
        options: fieldOptionsSchema.optional(),
        colors: optionColorFileSchema.optional(),
        scale: fieldScaleSchema.optional(),
        currency: currencySchema.optional(),
      }),
    )
    .max(MAX_FIELDS_PER_NOTEBOOK)
    .default([]),
});

/**
 * The file's text for a notebook and its definitions, in the order the API lists them.
 *
 * The emoji and the purpose are written only when the notebook has them, so the file for
 * a notebook with neither is byte for byte what it was before either key existed.
 */
export function serializeNotebook(
  notebook: { name: string; emoji?: string | null; purpose?: string | null },
  fields: FieldDef[],
): string {
  const definition: NotebookDefinition = {
    name: notebook.name,
    ...(notebook.emoji ? { emoji: notebook.emoji } : {}),
    ...(notebook.purpose ? { purpose: notebook.purpose } : {}),
    fields: fields.map((f) => ({
      name: f.name,
      type: f.type,
      // Only what the type can use: a select's or multi-select's options, a rating's
      // scale. An empty `options: []` on every text field would be noise a reader has to
      // learn to skip.
      ...(fieldHasOptions(f.type) ? { options: f.options } : {}),
      // By name, one per option the field has (a colour for an option that is gone would
      // be noise), and only when the server sent any, so a file from an older server is
      // unchanged.
      ...(fieldHasOptions(f.type) && f.optionColors
        ? { colors: Object.fromEntries(f.options.filter((o) => f.optionColors![o] !== undefined).map((o) => [o, colorName(f.optionColors![o]!)])) }
        : {}),
      ...(f.type === 'number' && f.scale ? { scale: f.scale } : {}),
      ...(f.type === 'number' && !f.scale && f.currency ? { currency: f.currency } : {}),
    })),
  };
  return stringifyYaml(definition, {
    lineWidth: 0,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  });
}

/** Thrown when a definitions file cannot be read; the message says which part. */
export class NotebookFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotebookFileError';
  }
}

/** Reads a definitions file back. Throws `NotebookFileError` rather than guessing. */
export function parseNotebook(text: string): NotebookDefinition {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (cause) {
    throw new NotebookFileError(`Malformed YAML: ${(cause as Error).message}`);
  }
  const result = notebookDefinitionSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.map(String).join('.')}` : '';
    throw new NotebookFileError(`${issue?.message ?? 'Not a notebook definition'}${where}`);
  }
  return {
    ...result.data,
    fields: result.data.fields.map(({ colors, ...field }) => ({
      ...field,
      ...(colors ? { optionColors: colors } : {}),
    })),
  };
}

/**
 * Where a notebook's definitions sit in the archive, from the same slug rule the note
 * directories use. The name inside the file is the one that counts; the filename is for
 * a person browsing the unpacked tree. Callers suffix a collision (two notebooks can
 * slug the same way) since only they can see the whole set.
 */
export const NOTEBOOKS_DIR = 'notebooks';

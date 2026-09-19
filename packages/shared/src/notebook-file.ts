/**
 * The notebook definitions file — the part of the export that is about a notebook rather
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
 * the notebook's own settings page shows: its name and its fields in order, each with its
 * type and, where it has them, its options or scale. Import reads these before any note,
 * so values land against typed definitions instead of guesses.
 *
 * YAML rather than JSON, and it was a close call. JSON is what a program would pick; but
 * every other file in the archive is markdown with YAML frontmatter, the parser is already
 * a dependency for that, and a person opening the zip to see what is in it should meet one
 * syntax, not two. Field order is the list order, which both formats keep.
 *
 * A definition file is deliberately not a manifest. It says what a notebook is, not what
 * the archive contains — the walker still finds notes by their own layout, and an archive
 * with no `notebooks/` directory (an older export, a hand-made vault) reads exactly as it
 * did before, with types inferred.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import {
  MAX_FIELDS_PER_NOTEBOOK,
  fieldHasOptions,
  fieldNameSchema,
  fieldOptionsSchema,
  fieldScaleSchema,
  fieldTypeSchema,
  type FieldDef,
  type FieldScale,
  type FieldType,
} from './fields.js';
import { notebookNameSchema } from './schemas.js';

/** One field as the file describes it. No id: ids never leave the database's world. */
export interface NotebookFileField {
  name: string;
  type: FieldType;
  /** Present only on a `select` or a `multiselect`. */
  options?: string[];
  /** Present only on a rating. */
  scale?: FieldScale;
}

/** A notebook as the file describes it: its name and its fields in display order. */
export interface NotebookDefinition {
  name: string;
  fields: NotebookFileField[];
}

/**
 * The file's shape, which is also what the import endpoint accepts.
 *
 * Strict where the field editor is strict — reserved names, the option cap, the rating
 * bounds — because a file that fails here was written by hand, not by the export, and a
 * clear refusal beats a definition that half-applies.
 */
export const notebookDefinitionSchema = z.object({
  name: notebookNameSchema,
  fields: z
    .array(
      z.object({
        name: fieldNameSchema,
        type: fieldTypeSchema,
        options: fieldOptionsSchema.optional(),
        scale: fieldScaleSchema.optional(),
      }),
    )
    .max(MAX_FIELDS_PER_NOTEBOOK)
    .default([]),
});

/** The file's text for a notebook and its definitions, in the order the API lists them. */
export function serializeNotebook(name: string, fields: FieldDef[]): string {
  const definition: NotebookDefinition = {
    name,
    fields: fields.map((f) => ({
      name: f.name,
      type: f.type,
      // Only what the type can use: a select's or multi-select's options, a rating's
      // scale. An empty `options: []` on every text field would be noise a reader has to
      // learn to skip.
      ...(fieldHasOptions(f.type) ? { options: f.options } : {}),
      ...(f.type === 'number' && f.scale ? { scale: f.scale } : {}),
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
  return result.data;
}

/**
 * Where a notebook's definitions sit in the archive, from the same slug rule the note
 * directories use. The name inside the file is the one that counts; the filename is for
 * a person browsing the unpacked tree. Callers suffix a collision — two notebooks can
 * slug the same way — since only they can see the whole set.
 */
export const NOTEBOOKS_DIR = 'notebooks';

import { z } from 'zod';
import {
  FIELD_FILTER_OPS,
  MAX_FIELD_VALUE_LENGTH,
  MAX_TAG_LENGTH,
  UNFILED,
  formatAttachmentMarkdown,
  parseFieldFilter,
  type FieldFilter,
} from '@unbent/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AttachmentsRepo } from '../../lib/attachments-repo.js';
import { nextCursor, type NotesRepo } from '../../lib/notes-repo.js';
import { notebookIdByName } from './lookup.js';
import { jsonResult, noteRef, notFound, toolError } from './result.js';

/**
 * The tools that only read.
 *
 * Schemas are written natively here rather than reused wholesale from `@unbent/shared`.
 * Those are query-string schemas — they coerce numbers out of strings and read `trashed` as
 * the literal "1" — because that is what a URL carries. MCP arguments arrive as real JSON,
 * so a number is a number and a boolean is a boolean, and a coercing schema would advertise
 * the wrong types to the model. The limits themselves are shared, so they cannot drift.
 */
const tagFilter = z
  .array(z.string().trim().min(1).max(MAX_TAG_LENGTH))
  .max(20)
  .optional()
  .describe('Only notes carrying every one of these tags, by exact name, case included.');

const notebookFilter = z
  .string()
  .optional()
  .describe(`Only notes in this notebook, by name. "${UNFILED}" means notes in no notebook.`);

/**
 * Which date `list_notes` filters on. It follows the sort, but "title" has no date of its
 * own and the trash is always ranged by when a note was trashed, so "whichever date the
 * sort names" — which this used to say — was wrong for both.
 */
const LIST_DATE_RANGE =
  'Inclusive (UTC). Filters the created date when sort is "created", otherwise the updated ' +
  'date; with trashed, the date the note was trashed.';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional();

/**
 * Narrowing by a custom field's value, the MCP's spelling of the web's `field=` filter.
 *
 * Fields are named, not numbered, as everywhere else a model meets them, and the op is
 * one of the shared five. The value is a string whatever the field's type — it is what
 * the URL form carries — and what it means is the field's: an option for `eq` on a select
 * or multiselect, `true`/`false` for a checkbox, `YYYY-MM-DD` or a number for a range.
 */
const fieldFiltersSchema = z
  .array(
    z.object({
      field: z.string().min(1).describe('A field name, as list_notebooks shows it for the notebook.'),
      op: z.enum(FIELD_FILTER_OPS),
      value: z.string().max(MAX_FIELD_VALUE_LENGTH).optional(),
    }),
  )
  .max(10)
  .optional()
  .describe(
    'Narrow by custom field values; every filter must hold. Needs notebook, since fields ' +
      'belong to one. op "eq" matches a value exactly (an option of a select, one of the ' +
      'options a multiselect holds, true or false for a checkbox, case included); "gte" and ' +
      '"lte" bound a number or a YYYY-MM-DD date, inclusive; "set" and "empty" ask whether ' +
      'the note has any value, and take no value. Example: ' +
      '{"field":"Expires","op":"lte","value":"2026-12-31"}.',
  );

/**
 * Turns named field filters into the id-keyed ones the store takes.
 *
 * The names are resolved against the notebook the list is scoped to, case-insensitively,
 * which is why `fields` needs one: a name means nothing outside a notebook, and two
 * notebooks may each have a "Date". The wire form is built and read back through
 * `parseFieldFilter`, the function the URL's `field=` goes through, so a bound that is not
 * a number or a date, or a value that is too long, is refused by the same rule here rather
 * than by a second copy of it. An unknown name lists the real ones, since the likeliest
 * cause is a misremembered name.
 */
async function resolveFieldFilters(
  notes: NotesRepo,
  notebook: string | undefined,
  filters: Array<{ field: string; op: FieldFilter['op']; value?: string | undefined }>,
): Promise<{ filters: FieldFilter[] } | { error: string }> {
  if (!notebook || notebook === UNFILED) {
    return {
      error:
        'Field filters need a notebook, since fields belong to one. Pass notebook with the ' +
        'name of the notebook whose fields you mean.',
    };
  }
  const notebookId = await notebookIdByName(notes, notebook);
  if (!notebookId) return { error: `No such notebook: ${notebook}` };
  const defs = (await notes.listFields(notebookId)) ?? [];

  const out: FieldFilter[] = [];
  for (const f of filters) {
    const def = defs.find((d) => d.name.toLowerCase() === f.field.trim().toLowerCase());
    if (!def) {
      return {
        error:
          `No field called "${f.field}" on notebook "${notebook}". ` +
          (defs.length ? `Its fields are: ${defs.map((d) => d.name).join(', ')}.` : 'It has no fields.'),
      };
    }
    const valueless = f.op === 'set' || f.op === 'empty';
    if (valueless && f.value !== undefined) return { error: `Op "${f.op}" takes no value.` };
    if (!valueless && !f.value) return { error: `Op "${f.op}" needs a value.` };
    const parsed = parseFieldFilter(valueless ? `${def.id}:${f.op}` : `${def.id}:${f.op}:${f.value}`);
    if (!parsed) {
      return {
        error: `"${f.value}" is not a usable ${f.op} value for ${def.name}: a range needs a number or a YYYY-MM-DD date.`,
      };
    }
    out.push(parsed);
  }
  return { filters: out };
}

export function registerReadTools(
  server: McpServer,
  notes: NotesRepo,
  attachments: AttachmentsRepo,
): void {
  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description:
        'Full-text search across note titles and bodies, tag names, custom field values, ' +
        'and text extracted from PDF attachments. Results are ranked, with title matches ' +
        'weighted above body matches, and note matches above tag matches above field ' +
        'matches above attachment matches; each carries a snippet with the matched terms ' +
        'marked. A result with matchedTag matched one of its tags by name; one with ' +
        'matchedField matched in that custom field\'s value; one with matchedFile matched ' +
        'inside that attachment. Terms are matched literally and ANDed; there is no operator ' +
        'syntax, so narrow with the tag, notebook and date arguments rather than by writing ' +
        'filters into the query.',
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe('Words to look for.'),
        limit: z.number().int().min(1).max(100).default(20),
        tag: tagFilter,
        notebook: notebookFilter,
        from: dateOnly.describe('Only notes created on or after this date (UTC).'),
        to: dateOnly.describe('Only notes created on or before this date (UTC).'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit, tag, notebook, from, to }) => {
      const results = await notes.search(query, limit, { tags: tag, notebook, from, to });
      return jsonResult({
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          title: r.title,
          updatedAt: new Date(r.updatedAt).toISOString(),
          snippet: r.snippet,
          ...(r.matchedFile ? { matchedFile: r.matchedFile } : {}),
          ...(r.matchedField ? { matchedField: r.matchedField } : {}),
          ...(r.matchedTag ? { matchedTag: r.matchedTag } : {}),
        })),
      });
    },
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description:
        'List notes without searching, newest first by default. Use this to browse, to page ' +
        'through a notebook or tag, to narrow a notebook by its custom field values, or — with ' +
        'sort "updated" and a from date — to find what changed recently. Returns an excerpt ' +
        'per note rather than the body; call get_note for that. When the response carries a ' +
        'cursor there are more notes, and passing it back returns the next page.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional().describe('The cursor from a previous page.'),
        tag: tagFilter,
        notebook: notebookFilter,
        fields: fieldFiltersSchema,
        sort: z.enum(['updated', 'created', 'title']).default('updated'),
        order: z.enum(['asc', 'desc']).default('desc'),
        from: dateOnly.describe(LIST_DATE_RANGE),
        to: dateOnly.describe(LIST_DATE_RANGE),
        trashed: z
          .boolean()
          .default(false)
          .describe(
            'List trashed notes instead of live ones, ordered by when they were trashed ' +
              'whatever the sort.',
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, cursor, tag, notebook, fields, sort, order, from, to, trashed }) => {
      let fieldFilters: FieldFilter[] | undefined;
      if (fields?.length) {
        const resolved = await resolveFieldFilters(notes, notebook, fields);
        if ('error' in resolved) return toolError(resolved.error);
        fieldFilters = resolved.filters;
      }
      const { items, total } = await notes.listPage(
        { limit, cursor, tags: tag, notebook, fields: fieldFilters, sort, order, from, to, trashed },
        { tags: tag, notebook, fields: fieldFilters, trashed, from, to, sort },
      );
      // The same helper the HTTP route uses, so a cursor means the same thing on both and
      // cannot disagree with the sort that produced the page.
      const cursorForNext = nextCursor(items, { limit, sort, trashed });
      return jsonResult({
        total,
        returned: items.length,
        ...(cursorForNext ? { cursor: cursorForNext } : {}),
        notes: items.map(noteRef),
      });
    },
  );

  server.registerTool(
    'get_note',
    {
      title: 'Get a note',
      description:
        'Read one note in full: its Markdown body, tags, notebook and timestamps, plus a list ' +
        'of its attachments, each with the exact Markdown that shows it in the body. ' +
        'Attachment bytes are not included — use get_attachment_text to read what a PDF ' +
        'says, and add_attachment to give the note a new file.',
      inputSchema: z.object({ noteId: z.string().uuid() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ noteId }) => {
      const found = await notes.getWithFiles(noteId);
      if (!found) return notFound('note', noteId);
      const { note, files } = found;
      return jsonResult({
        ...noteRef(note),
        body: note.body,
        /**
         * With the path and the Markdown, so a model can put a file back in the body, or
         * move a link, without being told the syntax — the angle brackets a name with a
         * space needs are the kind of thing a model gets wrong when left to infer them.
         */
        attachments: files.map((f) => {
          const path = `files/${f.filename}`;
          return {
            filename: f.filename,
            contentType: f.contentType,
            size: f.size,
            path,
            markdown: formatAttachmentMarkdown(f.filename, path, {
              image: f.contentType.startsWith('image/'),
            }),
          };
        }),
      });
    },
  );

  server.registerTool(
    'get_attachment_text',
    {
      title: 'Read an attachment as text',
      description:
        "The text extracted from an attachment: a PDF's text layer, or, where the instance " +
        'has a vision model, what it read off a picture or a text-less scan — a name, what ' +
        'the file is and shows, then any text on it. This is what makes a scanned document ' +
        'or a photo readable; the file itself is bytes a model cannot use. Reading happens ' +
        'in the background after upload, so a recently added file may have no text yet, ' +
        'which is reported as such rather than as an empty document; read_attachment ' +
        'asks for that read now.',
      inputSchema: z.object({
        noteId: z.string().uuid(),
        filename: z.string().min(1).describe('As listed by get_note.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ noteId, filename }) => {
      const text = await attachments.textFor(noteId, filename);
      if (text === null) return notFound('attachment', `${filename} on note ${noteId}`);
      if (!text) {
        return jsonResult({
          filename,
          indexed: false,
          note: 'This attachment has no extracted text. It may still be being processed, or it may be a file with no text layer, such as a photograph.',
        });
      }
      return jsonResult({ filename, indexed: true, text });
    },
  );

  server.registerTool(
    'list_notebooks',
    {
      title: 'List notebooks',
      description:
        'Every notebook with the number of live notes in it, plus the count of notes filed in ' +
        'none. Notebooks are flat: there is no nesting. Each notebook carries its purpose when ' +
        'one is set — a sentence saying what belongs in it, which auto-fill reads when filing a ' +
        'note — and its emoji when one is set, and lists its custom fields (name, type, and the options of a select or ' +
        'multiselect); values are read on a note and set by name through create_note and ' +
        'update_note.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const { notebooks, unfiled, fields = [] } = await notes.notebooksOverview({ fields: true });
      return jsonResult({
        notebooks: notebooks.map((nb) => ({
          id: nb.id,
          name: nb.name,
          count: nb.count,
          // Only when set, so a notebook without a purpose is silent rather than carrying a null.
          ...(nb.purpose ? { purpose: nb.purpose } : {}),
          ...(nb.emoji ? { emoji: nb.emoji } : {}),
          fields: fields
            .filter((f) => f.notebookId === nb.id)
            .map((f) => ({
              id: f.id,
              name: f.name,
              type: f.type,
              options: f.options,
              ...(f.scale ? { scale: f.scale } : {}),
              ...(f.currency ? { currency: f.currency } : {}),
            })),
        })),
        unfiled,
      });
    },
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        'Every tag with how many notes carry it, most used first. Tags are flat, and their ' +
        'names are case-sensitive: "Receipts" and "receipts" are two tags. Reuse a spelling ' +
        'from here when tagging, rather than making a near-duplicate. With notebook, tag or ' +
        'both, the counts are over the live notes of that set only — what else the notes in ' +
        'a notebook carry, or the notes that carry these tags — and tags with none in it are ' +
        'left out, as are the tags named in tag, which every note in the set carries.',
      inputSchema: z.object({
        notebook: notebookFilter,
        tag: tagFilter.describe(
          'Only count the notes carrying every one of these tags, by exact name; they are ' +
            'left out of the answer.',
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ notebook, tag }) => {
      // The unfiltered list is the stored per-tag counts, one row a tag; any filter has
      // to walk the notes in the set, so it only happens when one is asked for.
      if (notebook === undefined && !tag?.length) return jsonResult({ tags: await notes.listTags() });
      return jsonResult({ tags: await notes.tagCounts({ notebook, tags: tag?.length ? tag : undefined }) });
    },
  );
}

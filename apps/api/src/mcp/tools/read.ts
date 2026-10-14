import { z } from 'zod';
import {
  FIELD_FILTER_OPS,
  MAX_BATCH_NOTES,
  MAX_FIELD_FILTERS,
  MAX_FIELD_VALUE_LENGTH,
  MAX_TAG_LENGTH,
  UNFILED,
  formatAttachmentMarkdown,
  cursorSchema,
  formatFieldFilter,
  parseFieldFilter,
  type FieldDef,
  type FieldFilter,
} from '@unbent/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppLinks } from '../../lib/app-links.js';
import type { AttachmentsRepo } from '../../lib/attachments-repo.js';
import { nextCursor, type FileSummary, type NotesRepo } from '../../lib/notes-repo.js';
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
  .describe('Only notes carrying every one of these tags, by name in any case.');

// Trimmed, as the lookups that resolve a notebook by name already trim: the store matches
// the filter as given, so a name with a stray space resolved its fields and then listed
// nothing, with no error to say why.
const notebookFilter = z
  .string()
  .trim()
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

/**
 * How many notes a page of `list_notes` may carry.
 *
 * A full row has dates, field values and an excerpt, and a hundred of them is already a
 * long read. A compact row is an id, a title, a notebook and tags, there to be looked over
 * and passed on, so its ceiling is the one the batch tools take in a single call: five
 * hundred ids listed is five hundred ids moved, with no second page to stitch on.
 *
 * Compact keeps the notebook and tags rather than ids alone, deliberately. The point of
 * listing before a batch write is seeing what the write would touch, and "this receipt is
 * already filed somewhere else" is only visible with the notebook beside the title.
 */
const FULL_LIST_LIMIT = 100;
const COMPACT_LIST_LIMIT = MAX_BATCH_NOTES;

/**
 * How many fields a compact page may name in `include` (MAK-216). Enough for the few a
 * walk needs beside each title; past that a full page, which carries them all, is the
 * better read.
 */
const MAX_INCLUDED_FIELDS = 10;

/**
 * How many files' summaries one note carries on a page of `list_notes` or `search_notes`. The page is capped
 * at a hundred notes, but a note is not capped in files, and a few notes with dozens of
 * scans each would make a page of summaries the very context-filling read they are there
 * to save. A receipt or a business card has one or two; ten covers what a page is for, and
 * the rest are counted (`moreFiles`) and listed in full by get_note.
 */
const LIST_FILES_PER_NOTE = 10;

/**
 * What `read` and `summary` mean on a file, said once for `get_note` and `list_notes`
 * (MAK-172). The statuses are spelled out because "no summary" has two causes that call
 * for different moves — ask for the read (`pending`) or stop asking (`none`) — and a
 * model left to guess would call get_attachment_text on every one to find out which.
 */
const ATTACHMENT_SUMMARY =
  'read says how the file\'s text came to be: "vision" when the instance\'s vision model read ' +
  'it, on an Auto-fill press, and summary is its name and a line on what it shows (amounts, ' +
  'dates, who it is from); "assistant" when an assistant recorded what it read with ' +
  'set_attachment_text, and summary is the opening of that; ' +
  '"text" from a PDF\'s text layer, and summary is the opening of that text, then the ' +
  'total, dates and order or invoice number found in it ("Total: $18.67 · Date: ' +
  '2026-03-02 · Order #112-0042"), or up to three amounts in place of a total when none is ' +
  'labelled ("Amounts: $1,200.00, $14,350.10"), each left out when the text has none; "pending" ' +
  'when it has not been read yet — for a picture, get_attachment hands you the file and ' +
  'set_attachment_text records what you read; otherwise pressing Auto-fill on the note in ' +
  'the app reads it; "none" when it was read and nothing was found, or nothing on ' +
  'this instance reads that kind of file. summary is null unless read is "vision", "text" ' +
  'or "assistant", and is a few hundred characters at most: get_attachment_text has the whole text.';

/** The flag `list_notes` and `search_notes` share, so the two cannot describe it differently. */
const attachmentSummariesFlag = (whose: string, also = '') =>
  z
    .boolean()
    .default(false)
    .describe(
      `Also list ${whose} files as attachments: [{filename, read, summary}]. ` +
        ATTACHMENT_SUMMARY +
        ` At most ${LIST_FILES_PER_NOTE} files a note; moreFiles counts the rest, which ` +
        `get_note lists.${also}`,
    );

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
  .max(MAX_FIELD_FILTERS)
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
function resolveFieldFilters(
  defs: FieldDef[],
  notebook: string,
  filters: Array<{ field: string; op: FieldFilter['op']; value?: string | undefined }>,
): { filters: FieldFilter[] } | { error: string } {
  const out: FieldFilter[] = [];
  for (const f of filters) {
    const def = defByName(defs, f.field, notebook);
    if ('error' in def) return def;
    const valueless = f.op === 'set' || f.op === 'empty';
    if (valueless && f.value !== undefined) return { error: `Op "${f.op}" takes no value.` };
    if (!valueless && !f.value) return { error: `Op "${f.op}" needs a value.` };
    const parsed = parseFieldFilter(
      formatFieldFilter({ fieldId: def.id, op: f.op, ...(valueless ? {} : { value: f.value! }) }),
    );
    if (!parsed) {
      return {
        error: `"${f.value}" is not a usable ${f.op} value for ${def.name}: a range needs a number or a YYYY-MM-DD date.`,
      };
    }
    out.push(parsed);
  }
  return { filters: out };
}

/**
 * The field definitions of the notebook a list is scoped to, for the arguments that name
 * fields — `fields` and `include` — which is why each of them needs one: a name means
 * nothing outside a notebook, and two notebooks may each have a "Date". One call for the
 * notebook and its definitions, made once whichever of the two asked: this runs on each
 * page of a walk, ahead of the page itself.
 */
async function notebookFieldDefs(
  notes: NotesRepo,
  notebook: string | undefined,
  argument: string,
): Promise<{ defs: FieldDef[]; notebook: string } | { error: string }> {
  if (!notebook || notebook === UNFILED) {
    return {
      error:
        `${argument} a notebook, since fields belong to one. Pass notebook with the ` +
        'name of the notebook whose fields you mean.',
    };
  }
  const found = await notes.notebookByName(notebook);
  if (!found) return { error: `No such notebook: ${notebook}` };
  return { defs: found.fields, notebook };
}

/** A field by the name a model gave, without case; an unknown one lists the real ones. */
function defByName(defs: FieldDef[], name: string, notebook: string): FieldDef | { error: string } {
  const def = defs.find((d) => d.name.toLowerCase() === name.trim().toLowerCase());
  if (def) return def;
  return {
    error:
      `No field called "${name}" on notebook "${notebook}". ` +
      (defs.length ? `Its fields are: ${defs.map((d) => d.name).join(', ')}.` : 'It has no fields.'),
  };
}

/** A note's files as `list_notes` and `search_notes` carry them: the first few, and a count of the rest. */
function filesOf(files: FileSummary[]) {
  const shown = files.slice(0, LIST_FILES_PER_NOTE);
  return {
    attachments: shown.map((f) => ({ filename: f.filename, read: f.read, summary: f.summary })),
    ...(files.length > shown.length ? { moreFiles: files.length - shown.length } : {}),
  };
}

export function registerReadTools(
  server: McpServer,
  notes: NotesRepo,
  attachments: AttachmentsRepo,
  links: AppLinks,
  /** Whether the instance has the vision model, which decides what a file is still `pending` for. */
  readers: { vision: boolean },
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
        'filters into the query. With attachmentSummaries, each result also lists its ' +
        'note\'s files with a short summary of each, as list_notes does.',
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe('Words to look for.'),
        limit: z.number().int().min(1).max(100).default(20),
        attachmentSummaries: attachmentSummariesFlag("each matching note's"),
        tag: tagFilter,
        notebook: notebookFilter,
        from: dateOnly.describe('Only notes created on or after this date (UTC).'),
        to: dateOnly.describe('Only notes created on or before this date (UTC).'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit, attachmentSummaries, tag, notebook, from, to }) => {
      const filters = { tags: tag, notebook, from, to };
      // The plain search when the files were not asked for: the composite reads the files
      // of every match, which a search that only wants its hits should not pay for.
      const { results, summaries } = attachmentSummaries
        ? await notes.searchWithFiles(query, limit, filters, { vision: readers.vision })
        : { results: await notes.search(query, limit, filters), summaries: undefined };
      return jsonResult({
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          // Search reads live notes only, so a result always opens in the list.
          url: links.note(r.id),
          title: r.title,
          updatedAt: new Date(r.updatedAt).toISOString(),
          snippet: r.snippet,
          ...(r.matchedFile ? { matchedFile: r.matchedFile } : {}),
          ...(r.matchedField ? { matchedField: r.matchedField } : {}),
          ...(r.matchedTag ? { matchedTag: r.matchedTag } : {}),
          ...(summaries ? filesOf(summaries[r.id] ?? []) : {}),
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
        'per note rather than the body; call get_note for that. With attachmentSummaries, ' +
        'each note also lists its files with a short summary of each, which is usually enough ' +
        'to fill a notebook\'s fields from its scans without reading every file. When the ' +
        'response carries a cursor there are more notes, and passing it back returns the next ' +
        'page. The total comes with the first page only: a page asked for with a cursor does ' +
        'not repeat it.',
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(COMPACT_LIST_LIMIT)
          .default(25)
          .describe(`At most ${FULL_LIST_LIMIT}, or ${COMPACT_LIST_LIMIT} with compact.`),
        cursor: cursorSchema.optional().describe('The cursor from a previous page, exactly as it was given.'),
        compact: z
          .boolean()
          .default(false)
          .describe(
            'Only the id, title, notebook and tags of each note, with no dates, field values ' +
              `or excerpt, and up to ${COMPACT_LIST_LIMIT} a page. For collecting the ids of a ` +
              'large set to pass to move_notes, update_note_tags or update_note_fields, while ' +
              'still seeing what each note is and where it is filed.',
          ),
        include: z
          .array(z.string().trim().min(1))
          .min(1)
          .max(MAX_INCLUDED_FIELDS)
          .optional()
          .describe(
            'With compact, the custom fields to add to each row, by name, as fields keyed by ' +
              'name with null where a note has no value. Needs notebook, and every name must ' +
              'be one of its fields. For walking a notebook to fill or check a field when a ' +
              'value or two beside each title is all you need — a full page carries every ' +
              'field and an excerpt, and is a fifth of the size.',
          ),
        attachmentSummaries: attachmentSummariesFlag("each note's", ' Not with compact.'),
        tag: tagFilter,
        notebook: notebookFilter,
        fields: fieldFiltersSchema,
        untagged: z
          .boolean()
          .default(false)
          .describe(
            'Only notes with no tags at all, for finding what is left to tag. Cannot be ' +
              'combined with tag. Counting them reads every note in scope, so with a large ' +
              'archive give a notebook.',
          ),
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
    async ({ limit, cursor, compact, include, attachmentSummaries, tag, notebook, fields, untagged, sort, order, from, to, trashed }) => {
      if (attachmentSummaries && compact) {
        return toolError(
          'attachmentSummaries cannot be combined with compact: a compact page is up to ' +
            `${COMPACT_LIST_LIMIT} notes, and a summary per file of each is no longer compact. ` +
            `Page through with compact false, up to ${FULL_LIST_LIMIT} at a time.`,
        );
      }
      if (limit > FULL_LIST_LIMIT && !compact) {
        return toolError(
          `limit is at most ${FULL_LIST_LIMIT} unless compact is true, which allows ${COMPACT_LIST_LIMIT}.`,
        );
      }
      if (untagged && tag?.length) {
        return toolError('untagged means notes with no tags, so it cannot be combined with tag.');
      }
      if (include && !compact) {
        return toolError(
          'include is for compact pages. A full page already carries every field of each note; ' +
            'pass compact true to get only the fields you name.',
        );
      }
      let scope: { defs: FieldDef[]; notebook: string } | undefined;
      if (fields?.length || include) {
        const found = await notebookFieldDefs(notes, notebook, fields?.length ? 'Field filters need' : 'include needs');
        if ('error' in found) return toolError(found.error);
        scope = found;
      }
      let fieldFilters: FieldFilter[] | undefined;
      if (fields?.length) {
        const resolved = resolveFieldFilters(scope!.defs, scope!.notebook, fields);
        if ('error' in resolved) return toolError(resolved.error);
        fieldFilters = resolved.filters;
      }
      const included: FieldDef[] = [];
      for (const name of include ?? []) {
        const def = defByName(scope!.defs, name, scope!.notebook);
        if ('error' in def) return toolError(def.error);
        if (!included.includes(def)) included.push(def);
      }
      const { items, total, summaries } = await notes.listPage(
        {
          limit,
          cursor,
          tags: tag,
          notebook,
          fields: fieldFilters,
          untagged,
          compact,
          compactFields: included.map((d) => d.id),
          sort,
          order,
          from,
          to,
          trashed,
        },
        // Counted once, on the first page. A count that no stored number answers — a field
        // filter, a date range, `untagged` — reads every note in scope, and repeating it on
        // each page of a long walk cost more than the pages did: ten pages of the untagged
        // notes of a three-thousand-note account read 48,000 rows, 45,000 of them counting.
        // The answer cannot have changed in a way the caller could use mid-walk anyway.
        cursor ? null : { tags: tag, notebook, fields: fieldFilters, untagged, trashed, from, to, sort },
        { summaries: attachmentSummaries, vision: readers.vision },
      );
      // The same helper the HTTP route uses, so a cursor means the same thing on both and
      // cannot disagree with the sort that produced the page.
      const cursorForNext = nextCursor(items, { limit, sort, trashed });
      return jsonResult({
        ...(total === null ? {} : { total }),
        returned: items.length,
        ...(cursorForNext ? { cursor: cursorForNext } : {}),
        notes: compact
          ? // No url: compact is for collecting up to five hundred ids for a batch write,
            // where a link per row would double the page, and the batch's own answer
            // carries the link of every note it changed.
            items.map((n) => ({
              id: n.id,
              title: n.title,
              notebook: n.notebook ?? null,
              tags: n.tags,
              // By id, not by the name a value carries: a note may hold a leftover value
              // from another notebook under the same name, and the field asked for is
              // this notebook's. Every name asked for is a key, so "no value" is an answer.
              ...(included.length > 0
                ? {
                    fields: Object.fromEntries(
                      included.map((d) => [d.name, n.fields?.find((v) => v.fieldId === d.id)?.value ?? null]),
                    ),
                  }
                : {}),
            }))
          : items.map((n) => ({
              ...noteRef(n, links),
              // Every note gets the key when it was asked for, an empty list included, so
              // "no files" is an answer rather than a missing field.
              ...(summaries ? filesOf(summaries[n.id] ?? []) : {}),
            })),
      });
    },
  );

  server.registerTool(
    'get_note',
    {
      title: 'Get a note',
      description:
        'Read one note in full: its Markdown body, tags, notebook and timestamps, plus a list ' +
        'of its attachments, each with the exact Markdown that shows it in the body and a ' +
        'short summary of what it is. ' +
        ATTACHMENT_SUMMARY +
        ' Attachment bytes are not included — use get_attachment_text for the whole of what a ' +
        'file says, and add_attachment to give the note a new file.',
      inputSchema: z.object({ noteId: z.string().uuid() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ noteId }) => {
      const found = await notes.getWithFiles(noteId, { vision: readers.vision });
      if (!found) return notFound('note', noteId);
      const { note, files } = found;
      return jsonResult({
        ...noteRef(note, links),
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
            read: f.read,
            summary: f.summary,
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
        "The text held for an attachment: a PDF's text layer; what the instance's vision " +
        'model read off a picture or a text-less scan when someone pressed Auto-fill on its ' +
        'note — a name, what the file is and shows, then any text on it; or what an ' +
        'assistant recorded with set_attachment_text. This is what makes a scanned document ' +
        "or a photo readable. A PDF's layer is read after upload and a picture only on a " +
        'press, so a file may have no text yet, which is reported as such rather than as an ' +
        'empty document. read says which, as it does on get_note: "pending" for a file still ' +
        'to be read — a picture you can read yourself with get_attachment and record with ' +
        'set_attachment_text — and "none" for one that was read and had nothing, or that ' +
        'nothing on this instance reads. A receipt or a statement usually says what it is in its ' +
        'first page and spends the rest on terms: pass maxChars to read only the opening, ' +
        'and offset to read on from where a cut answer stopped.',
      inputSchema: z.object({
        noteId: z.string().uuid(),
        filename: z.string().min(1).describe('As listed by get_note.'),
        maxChars: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'The most characters of text to return. Omitted, the whole text is returned. ' +
              'When the text is longer, the answer says truncated, totalChars and nextOffset.',
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Where in the text to start, in characters; 0 by default. Pass a nextOffset here.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ noteId, filename, maxChars, offset = 0 }) => {
      const found = await attachments.textWithRead(noteId, filename, readers.vision);
      if (!found) return notFound('attachment', `${filename} on note ${noteId}`);
      const { read, text } = found;
      // `indexed` stays beside `read`: it is what this tool has always answered, and a
      // client written against it should not have to learn the new word to keep working.
      if (text === null) {
        return jsonResult({
          filename,
          indexed: false,
          read,
          note:
            read === 'pending'
              ? 'This attachment has not been read yet. If it is a picture, get_attachment returns it for you to read and set_attachment_text records what you read; otherwise pressing Auto-fill on the note in the app reads it.'
              : 'This attachment has no text: it was read and nothing was found, or nothing on this instance reads this kind of file.',
        });
      }
      /*
         A call that asks for neither gets the answer it always got, with no new keys:
         the paging fields appear only once the caller has asked for a part of the text.
         Cut here rather than in the store: the store's read is the same row either way,
         and what the cut saves is the model's context, not the object's rows.
      */
      if (maxChars === undefined && offset === 0) return jsonResult({ filename, indexed: true, read, text });
      const end = maxChars === undefined ? text.length : Math.min(text.length, offset + maxChars);
      const truncated = end < text.length;
      return jsonResult({
        filename,
        indexed: true,
        read,
        text: text.slice(offset, end),
        totalChars: text.length,
        ...(offset > 0 ? { offset } : {}),
        truncated,
        ...(truncated ? { nextOffset: end } : {}),
      });
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
          // The note list filtered to this notebook, which is the only page a notebook has.
          url: links.notebook(nb.name),
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
        'Every tag with how many notes carry it, most used first. Tags are flat, and a name ' +
        'is one tag in any case: tagging a note "receipts" when Receipts exists gives it ' +
        'Receipts. Reuse a name from here when tagging, rather than making a near-duplicate ' +
        'such as "receipt" beside "Receipts". With notebook, tag or ' +
        'both, the counts are over the live notes of that set only — what else the notes in ' +
        'a notebook carry, or the notes that carry these tags — and tags with none in it are ' +
        'left out, as are the tags named in tag, which every note in the set carries.',
      inputSchema: z.object({
        notebook: notebookFilter,
        tag: tagFilter.describe(
          'Only count the notes carrying every one of these tags, by name in any case; they are ' +
            'left out of the answer.',
        ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ notebook, tag }) => {
      // The unfiltered list is the stored per-tag counts, one row a tag; any filter has
      // to walk the notes in the set, so it only happens when one is asked for.
      if (notebook === undefined && !tag?.length) return jsonResult({ tags: await notes.listTags() });
      const tags = await notes.tagCounts({ notebook, tags: tag?.length ? tag : undefined });
      // An empty answer for a notebook that does not exist reads as "its notes have no
      // tags", which is a finding an assistant would repeat. Checked only when the answer
      // is empty, so the usual call stays one request.
      if (tags.length === 0 && notebook !== undefined && notebook !== UNFILED) {
        if (!(await notes.notebookByName(notebook))) return toolError(`No such notebook: ${notebook}`);
      }
      return jsonResult({ tags });
    },
  );
}

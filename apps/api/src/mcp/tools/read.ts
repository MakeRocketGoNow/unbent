import { z } from 'zod';
import { MAX_TAG_LENGTH, UNFILED } from '@unbent/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AttachmentsRepo } from '../../lib/attachments-repo.js';
import { nextCursor, type NotesRepo } from '../../lib/notes-repo.js';
import { jsonResult, noteRef, notFound } from './result.js';

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
  .describe('Only notes carrying every one of these tags.');

const notebookFilter = z
  .string()
  .optional()
  .describe(`Only notes in this notebook, by name. "${UNFILED}" means notes in no notebook.`);

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional();

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
        'Full-text search across note titles and bodies, and across text extracted from PDF ' +
        'attachments. Results are ranked, with title matches weighted above body matches and ' +
        'note matches above attachment matches, and each carries a snippet with the matched ' +
        'terms marked. A result with matchedFile matched inside that attachment rather than ' +
        'in the note body. Terms are matched literally and ANDed; there is no operator ' +
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
        'through a notebook or tag, or — with sort "updated" and a from date — to find what ' +
        'changed recently. Returns an excerpt per note rather than the body; call get_note ' +
        'for that. When the response carries a cursor there are more notes, and passing it ' +
        'back returns the next page.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional().describe('The cursor from a previous page.'),
        tag: tagFilter,
        notebook: notebookFilter,
        sort: z.enum(['updated', 'created', 'title']).default('updated'),
        order: z.enum(['asc', 'desc']).default('desc'),
        from: dateOnly.describe('Inclusive, filtering whichever date the sort names.'),
        to: dateOnly.describe('Inclusive, filtering whichever date the sort names.'),
        trashed: z.boolean().default(false).describe('List trashed notes instead of live ones.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, cursor, tag, notebook, sort, order, from, to, trashed }) => {
      const items = await notes.list({
        limit,
        cursor,
        tags: tag,
        notebook,
        sort,
        order,
        from,
        to,
        trashed,
      });
      const total = await notes.count({ tags: tag, notebook, trashed, from, to, sort });
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
        'of its attachments. Attachment bytes are not included — use get_attachment_text to ' +
        'read what a PDF says.',
      inputSchema: z.object({ noteId: z.string().uuid() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ noteId }) => {
      const note = await notes.get(noteId);
      if (!note) return notFound('note', noteId);
      const files = await attachments.listForNote(noteId);
      return jsonResult({
        ...noteRef(note),
        body: note.body,
        attachments: files.map((f) => ({
          filename: f.filename,
          contentType: f.contentType,
          size: f.size,
        })),
      });
    },
  );

  server.registerTool(
    'get_attachment_text',
    {
      title: 'Read an attachment as text',
      description:
        "The text extracted from an attachment — a PDF's text layer, typically. This is what " +
        'makes a scanned document readable; the file itself is bytes a model cannot use. ' +
        'Extraction happens in the background after upload, so a recently added file may have ' +
        'no text yet, which is reported as such rather than as an empty document.',
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
        'none. Notebooks are flat: there is no nesting. Each notebook lists its custom fields ' +
        '(name, type, and the options of a select); values are read on a note and set by ' +
        'name through create_note and update_note.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const [notebooks, unfiled, fields] = await Promise.all([
        notes.listNotebooks(),
        notes.countUnfiledNotes(),
        notes.listAllFields(),
      ]);
      return jsonResult({
        notebooks: notebooks.map((nb) => ({
          id: nb.id,
          name: nb.name,
          count: nb.count,
          fields: fields
            .filter((f) => f.notebookId === nb.id)
            .map((f) => ({ id: f.id, name: f.name, type: f.type, options: f.options })),
        })),
        unfiled,
      });
    },
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description: 'Every tag with how many notes carry it, most used first. Tags are flat.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => jsonResult({ tags: await notes.listTags() }),
  );
}

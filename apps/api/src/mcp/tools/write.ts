import { z } from 'zod';
import {
  MAX_BODY_BYTES,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
  UNFILED,
  notebookNameSchema,
  tagNameSchema,
} from '@unbent/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import type { NotesRepo } from '../../lib/notes-repo.js';
import { jsonResult, noteRef, notFound } from './result.js';

const bodySchema = z
  .string()
  .max(MAX_BODY_BYTES)
  .describe('Markdown. Headings, lists, tables, task lists and links all render.');

const tagsSchema = z.array(tagNameSchema).max(50);

/**
 * A notebook name, or null to file the note in none.
 *
 * `[unfiled]` is the sentinel the rest of the app uses for "no notebook" in a filter, and a
 * model that has seen it in a list is liable to send it back as a destination. Treating it
 * as null rather than creating a notebook with that literal name is the difference between
 * doing what was meant and quietly making a mess.
 */
const notebookSchema = z
  .union([notebookNameSchema, z.null()])
  .describe(`Notebook name, or null for none. "${UNFILED}" also means none.`);

function normalizeNotebook(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === UNFILED) return null;
  return value;
}

export function registerWriteTools(server: McpServer, notes: NotesRepo): void {
  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description:
        'Create a note with its body in one call. The body is Markdown — write the whole ' +
        'note here rather than creating something empty and editing it afterwards.',
      inputSchema: z.object({
        title: z.string().max(MAX_TITLE_LENGTH).default(''),
        body: bodySchema.default(''),
        tags: tagsSchema.default([]),
        notebook: notebookSchema.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, body, tags, notebook }) => {
      const note = await notes.create({
        id: crypto.randomUUID(),
        title,
        body,
        tags,
        notebook: normalizeNotebook(notebook),
      });
      return jsonResult(noteRef(note));
    },
  );

  server.registerTool(
    'update_note',
    {
      title: 'Replace parts of a note',
      description:
        'Overwrite whole fields of a note. Every argument is optional and only what is ' +
        'supplied changes, but what is supplied replaces rather than merges — passing tags ' +
        'sets the tag list to exactly that. To change part of a body without resending it, ' +
        'use edit_note.',
      inputSchema: z.object({
        noteId: z.string().uuid(),
        title: z.string().max(MAX_TITLE_LENGTH).optional(),
        body: bodySchema.optional(),
        tags: tagsSchema.optional(),
        notebook: notebookSchema.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId, title, body, tags, notebook }) => {
      const note = await notes.update(noteId, {
        title,
        body,
        tags,
        notebook: normalizeNotebook(notebook),
      });
      if (!note) return notFound('note', noteId);
      return jsonResult(noteRef(note));
    },
  );

  server.registerTool(
    'edit_note',
    {
      title: 'Edit part of a note',
      description:
        'Change a note without resending its body. Append or prepend a fragment, or replace ' +
        'an exact span of text with another. Prefer this to update_note for anything but a ' +
        'wholesale rewrite: it is cheaper on a long note and it cannot accidentally discard ' +
        'the parts you did not mean to touch.',
      inputSchema: z.object({
        noteId: z.string().uuid(),
        mode: z.enum(['append', 'prepend', 'replace']),
        content: z
          .string()
          .describe('The Markdown to add, or to substitute in. Empty deletes, with replace.'),
        find: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Required for replace: the exact text to substitute. Must appear exactly once — ' +
              'include enough surrounding text to be unique.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ noteId, mode, content, find }) => {
      if (mode === 'replace' && find === undefined) {
        return toolError('replace needs a find argument saying what to substitute.');
      }
      if (mode !== 'replace' && !content) {
        return toolError(`${mode} needs content.`);
      }

      /**
       * Append has a repo method that does it in SQL, so it neither reads the body back nor
       * races another writer over it. The other two modes have to read, and are read-modify-
       * write: two edits to one note in the same instant can lose one. Acceptable here, and
       * worth stating — the alternative is a compare-and-swap on a column that does not
       * exist yet, for a conflict that needs two agents editing one note at once.
       */
      if (mode === 'append') {
        const ok = await notes.appendToBody(noteId, content);
        if (!ok) return notFound('note', noteId);
        const note = await notes.get(noteId);
        return note ? jsonResult(noteRef(note)) : notFound('note', noteId);
      }

      const current = await notes.get(noteId);
      if (!current) return notFound('note', noteId);

      let body: string;
      if (mode === 'prepend') {
        body = `${content}\n\n${current.body}`;
      } else {
        const occurrences = current.body.split(find!).length - 1;
        if (occurrences === 0) {
          return toolError(
            'That text does not appear in the note. Copy it exactly from get_note, whitespace included.',
          );
        }
        if (occurrences > 1) {
          return toolError(
            `That text appears ${occurrences} times, so it is ambiguous. Include more surrounding text to pick out the one you mean.`,
          );
        }
        body = current.body.replace(find!, content);
      }

      const note = await notes.update(noteId, { body });
      if (!note) return notFound('note', noteId);
      return jsonResult(noteRef(note));
    },
  );

  server.registerTool(
    'update_note_tags',
    {
      title: 'Add or remove tags',
      description:
        'Add and remove tags across one or more notes without touching their other fields. ' +
        'Tags that are already there, or already absent, are left alone.',
      inputSchema: z.object({
        noteIds: z.array(z.string().uuid()).min(1).max(50),
        add: z.array(z.string().trim().min(1).max(MAX_TAG_LENGTH)).default([]),
        remove: z.array(z.string().trim().min(1).max(MAX_TAG_LENGTH)).default([]),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteIds, add, remove }) => {
      if (!add.length && !remove.length) {
        return toolError('Nothing to do: pass tags to add, to remove, or both.');
      }
      const removing = new Set(remove);
      // Sequential rather than concurrent: D1 is one connection, and a batch of 50 parallel
      // read-modify-writes buys nothing but contention.
      const results = [];
      for (const id of noteIds) {
        const note = await notes.get(id);
        if (!note) {
          results.push({ noteId: id, ok: false, error: 'no such note' });
          continue;
        }
        const tags = [...new Set([...note.tags.filter((t) => !removing.has(t)), ...add])];
        const updated = await notes.update(id, { tags });
        results.push(
          updated
            ? { noteId: id, ok: true, tags: updated.tags }
            : { noteId: id, ok: false, error: 'no such note' },
        );
      }
      return jsonResult({ results });
    },
  );

  server.registerTool(
    'move_notes',
    {
      title: 'Move notes to a notebook',
      description:
        'File one or more notes into a notebook, or out of every notebook with null. The ' +
        'notebook is created if it does not exist.',
      inputSchema: z.object({
        noteIds: z.array(z.string().uuid()).min(1).max(50),
        notebook: notebookSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteIds, notebook }) => {
      const target = normalizeNotebook(notebook) ?? null;
      const results = [];
      for (const id of noteIds) {
        const updated = await notes.update(id, { notebook: target });
        results.push(
          updated
            ? { noteId: id, ok: true, notebook: updated.notebook ?? null }
            : { noteId: id, ok: false, error: 'no such note' },
        );
      }
      return jsonResult({ results });
    },
  );

  server.registerTool(
    'delete_note',
    {
      title: 'Move a note to the trash',
      description:
        'Trash a note. This is reversible — the note stays in the trash until someone empties ' +
        'it, and restore_note brings it back. There is no tool that deletes permanently.',
      inputSchema: z.object({ noteId: z.string().uuid() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId }) => {
      const ok = await notes.remove(noteId);
      if (!ok) return notFound('note', noteId);
      return jsonResult({ noteId, trashed: true });
    },
  );

  server.registerTool(
    'restore_note',
    {
      title: 'Restore a note from the trash',
      description: 'Bring a trashed note back. Find one with list_notes and trashed set to true.',
      inputSchema: z.object({ noteId: z.string().uuid() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId }) => {
      const ok = await notes.restore(noteId);
      if (!ok) return notFound('trashed note', noteId);
      return jsonResult({ noteId, restored: true });
    },
  );

  server.registerTool(
    'create_notebook',
    {
      title: 'Create a notebook',
      description:
        'Make an empty notebook. Notebooks are also created on demand by move_notes and ' +
        'create_note, so this is only needed to make one ahead of time.',
      inputSchema: z.object({ name: notebookNameSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ name }) => {
      const created = await notes.createNotebook(name);
      if (!created) return toolError(`A notebook called "${name}" already exists.`);
      return jsonResult(created);
    },
  );

  server.registerTool(
    'rename_notebook',
    {
      title: 'Rename a notebook',
      description: 'Rename a notebook by id. Get the id from list_notebooks.',
      inputSchema: z.object({ notebookId: z.string().min(1), name: notebookNameSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ notebookId, name }) => {
      const outcome = await notes.renameNotebook(notebookId, name);
      if (outcome === 'missing') return notFound('notebook', notebookId);
      if (outcome === 'conflict') return toolError(`A notebook called "${name}" already exists.`);
      return jsonResult({ id: notebookId, name });
    },
  );
}

/**
 * A failure the model should read and act on, rather than an exception.
 *
 * `isError` is how MCP says "this call failed" without ending the conversation: the text
 * goes back to the model, which can correct itself and try again. So these read as
 * instructions to the caller, not as log lines.
 */
function toolError(message: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

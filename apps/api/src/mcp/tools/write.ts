import { z } from 'zod';
import {
  FIELD_TYPES,
  InvalidFieldValue,
  MAX_BATCH_NOTES,
  MAX_BODY_BYTES,
  MAX_FIELD_VALUE_LENGTH,
  MAX_RATING_MAX,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_RATING_MAX,
  UNFILED,
  currencySchema,
  fieldNameSchema,
  fieldOptionsSchema,
  fieldScaleSchema,
  fieldTypeSchema,
  notebookNameSchema,
  notebookEmojiSchema,
  notebookPurposeSchema,
  tagNameSchema,
  type FieldDef,
  type FieldValue,
  type NoteFieldValue,
  type NoteFieldsPatch,
} from '@unbent/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import type { NotesRepo } from '../../lib/notes-repo.js';
import { notebookIdByName } from './lookup.js';
import { jsonResult, noteRef, notFound, staleNote, toolError } from './result.js';

/**
 * Custom field values by field *name*, the way list_notebooks reports them and get_note
 * shows them. Ids never reach a model: a name is what it read, and what it will say back.
 */
const fieldsSchema = z
  .record(
    z.string().min(1),
    z.union([
      z.string().max(MAX_FIELD_VALUE_LENGTH),
      z.number(),
      z.boolean(),
      z.array(z.string().max(MAX_FIELD_VALUE_LENGTH)),
      z.null(),
    ]),
  )
  .describe(
    'Custom field values keyed by field name, as list_notebooks reports them for the ' +
      'notebook. Null clears one. Only the names given change. A value must fit the ' +
      'field\'s type: a number for number (from 1 to its max when it has a rating scale, ' +
      'in halves only when the step is 0.5), YYYY-MM-DD for date, true/false for ' +
      'checkbox, an http(s) address for url, one of the options for select, a list of ' +
      'the options for multiselect. Options match exactly as listed, case included; one ' +
      'the field lacks is refused, so add it with update_notebook_field first. A ' +
      'multiselect list is the whole selection, not an addition to it: to add one, send ' +
      'what the note holds plus the new one.',
  );

/**
 * Maps the names a model sent to the ids the repo stores by.
 *
 * Candidates are the target notebook's definitions and, on an existing note, any values it
 * already carries from another notebook, so a field left over from a move can still be
 * cleared. Case-insensitive, own notebook first. An unknown name is an error that lists
 * the real ones, since the likeliest cause is a misremembered name.
 */
function resolveFieldNames(
  byName: Record<string, FieldValue | null>,
  defs: FieldDef[],
  existing: NoteFieldValue[],
  notebookName: string | null,
): { patch: NoteFieldsPatch } | { error: string } {
  const ids = new Map<string, string>();
  for (const v of existing) ids.set(v.name.toLowerCase(), v.fieldId);
  for (const d of defs) ids.set(d.name.toLowerCase(), d.id);

  const patch: NoteFieldsPatch = {};
  for (const [name, value] of Object.entries(byName)) {
    const id = ids.get(name.trim().toLowerCase());
    if (!id) {
      const known = [...new Set([...defs.map((d) => d.name), ...existing.map((v) => v.name)])];
      const where = notebookName ? `notebook "${notebookName}"` : 'a note in no notebook';
      return {
        error:
          `No field called "${name}" on ${where}. ` +
          (known.length
            ? `Its fields are: ${known.join(', ')}. `
            : 'It has no fields yet. ') +
          'Add one with create_notebook_field.',
      };
    }
    patch[id] = value;
  }
  return { patch };
}

const bodySchema = z
  .string()
  .max(MAX_BODY_BYTES)
  .describe('Markdown. Headings, lists, tables, task lists and links all render.');

const tagsSchema = z
  .array(tagNameSchema)
  .max(50)
  .describe(
    'Tag names, matched exactly: "Receipts" and "receipts" are two tags. Reuse the ' +
      'spelling list_tags shows.',
  );

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
        fields: fieldsSchema.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, body, tags, notebook, fields }) => {
      const target = normalizeNotebook(notebook);
      let patch: NoteFieldsPatch | undefined;
      if (fields && Object.keys(fields).length > 0) {
        // Fields belong to a notebook, so values need one to be resolved against. A
        // notebook that does not exist yet has no fields, which the error says.
        const notebookId = target ? await notebookIdByName(notes, target) : null;
        const defs = notebookId ? ((await notes.listFields(notebookId)) ?? []) : [];
        const resolved = resolveFieldNames(fields, defs, [], target ?? null);
        if ('error' in resolved) return toolError(resolved.error);
        patch = resolved.patch;
      }
      try {
        const note = await notes.create({
          id: crypto.randomUUID(),
          title,
          body,
          tags,
          notebook: target,
          ...(patch ? { fields: patch } : {}),
        });
        return jsonResult(noteRef(note));
      } catch (err) {
        if (err instanceof InvalidFieldValue) return toolError(`${err.fieldName} ${err.message}.`);
        throw err;
      }
    },
  );

  server.registerTool(
    'update_note',
    {
      title: 'Replace parts of a note',
      description:
        'Overwrite whole fields of a note. Every argument is optional and only what is ' +
        'supplied changes, but what is supplied replaces rather than merges — passing tags ' +
        'sets the tag list to exactly that. Custom field values are the exception: only the ' +
        'names given change, and null clears one. To change part of a body without ' +
        'resending it, use edit_note. Pass the updatedAt get_note gave you as ' +
        'ifUpdatedAt and the update is refused if the note was saved since, rather than ' +
        'overwriting someone else\'s edit.',
      inputSchema: z.object({
        noteId: z.string().uuid(),
        title: z.string().max(MAX_TITLE_LENGTH).optional(),
        body: bodySchema.optional(),
        tags: tagsSchema.optional(),
        notebook: notebookSchema.optional(),
        fields: fieldsSchema.optional(),
        ifUpdatedAt: z
          .string()
          .datetime()
          .optional()
          .describe('The note\'s updatedAt from get_note, exactly as it was given.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId, title, body, tags, notebook, fields, ifUpdatedAt }) => {
      const target = normalizeNotebook(notebook);
      let patch: NoteFieldsPatch | undefined;
      if (fields && Object.keys(fields).length > 0) {
        const current = await notes.get(noteId);
        if (!current) return notFound('note', noteId);
        // Resolved against the notebook the note will be in after this call, plus whatever
        // it already carries, so a leftover value from an earlier notebook can be cleared.
        const notebookName = target === undefined ? (current.notebook ?? null) : target;
        const notebookId =
          target === undefined
            ? (current.notebookId ?? null)
            : target
              ? await notebookIdByName(notes, target)
              : null;
        const defs = notebookId ? ((await notes.listFields(notebookId)) ?? []) : [];
        const resolved = resolveFieldNames(fields, defs, current.fields ?? [], notebookName);
        if ('error' in resolved) return toolError(resolved.error);
        patch = resolved.patch;
      }
      try {
        const note = await notes.update(noteId, {
          title,
          body,
          tags,
          notebook: target,
          ...(patch ? { fields: patch } : {}),
          // ISO-8601 out, so ISO-8601 back in; `noteRef` keeps the milliseconds, which is
          // what makes the round trip exact.
          ...(ifUpdatedAt ? { ifUpdatedAt: Date.parse(ifUpdatedAt) } : {}),
        });
        if (!note) return notFound('note', noteId);
        if ('stale' in note) return staleNote(note.stale);
        return jsonResult(noteRef(note));
      } catch (err) {
        if (err instanceof InvalidFieldValue) return toolError(`${err.fieldName} ${err.message}.`);
        throw err;
      }
    },
  );

  server.registerTool(
    'edit_note',
    {
      title: 'Edit part of a note',
      description:
        'Change a note without resending its body. Append or prepend a fragment, which is ' +
        'set off from the body by a blank line, or replace an exact span of text with ' +
        'another. Prefer this to update_note for anything but a wholesale rewrite: it is ' +
        'cheaper on a long note and it cannot accidentally discard the parts you did not ' +
        'mean to touch.',
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
       * write, so the write is made conditional on the read: it carries the `updatedAt` it
       * read, and a save that landed in between — the editor's autosave, another agent —
       * refuses it rather than being overwritten with a body built from the older text.
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
        // A function, not the string itself: String.replace reads `$'`, `$&` and `$$` in a
        // replacement string as patterns, so a shell snippet or a price in the content
        // would splice in other parts of the body instead of landing as written.
        body = current.body.replace(find!, () => content);
      }

      const note = await notes.update(noteId, { body, ifUpdatedAt: current.updatedAt });
      if (!note) return notFound('note', noteId);
      if ('stale' in note) return staleNote(note.stale);
      return jsonResult(noteRef(note));
    },
  );

  /*
     The tools that take several notes go through the repo's batch methods — one read and
     one transaction for the set, where each used to read and write every note in turn,
     which is what capped them at fifty. They answer with which ids were done, how many of
     those actually changed (a note already there, or already carrying the tag, keeps its
     date), and which ids were not found: an assistant re-running a step it already ran
     is ordinary, and a stale id must not stop the other forty-nine.
  */
  const noteIdsSchema = z.array(z.string().uuid()).min(1).max(MAX_BATCH_NOTES);

  server.registerTool(
    'update_note_tags',
    {
      title: 'Add or remove tags',
      description:
        'Add and remove tags across one or more notes without touching their other fields. ' +
        'Tags that are already there, or already absent, are left alone, and a tag named ' +
        'in both lists is added. Names match exactly, case included, so removing ' +
        '"receipts" leaves "Receipts" in place; list_tags has the spellings. Answers with the ' +
        'notes it reached, how many changed, and any ids it could not find; get_note shows ' +
        "a note's tags afterwards.",
      inputSchema: z.object({
        noteIds: noteIdsSchema,
        add: z.array(z.string().trim().min(1).max(MAX_TAG_LENGTH)).default([]),
        remove: z.array(z.string().trim().min(1).max(MAX_TAG_LENGTH)).default([]),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteIds, add, remove }) => {
      if (!add.length && !remove.length) {
        return toolError('Nothing to do: pass tags to add, to remove, or both.');
      }
      const { matched, changed } = await notes.updateMany(noteIds, {
        addTags: add,
        removeTags: remove,
      });
      return jsonResult({
        noteIds: matched,
        changed: changed.length,
        missing: noteIds.filter((id) => !matched.includes(id)),
      });
    },
  );

  server.registerTool(
    'update_note_fields',
    {
      title: 'Set custom field values on several notes',
      description:
        'Set the same custom field values on one or more notes at once, by field name, ' +
        'without touching anything else about them. The values follow update_note\'s rules: ' +
        'only the fields named change, null clears one, and a value must fit its field. All ' +
        'the notes must be in one notebook, and the fields must be that notebook\'s; notes ' +
        'from different notebooks, or in none, are refused, so group them first with ' +
        'list_notes or move_notes. A note that already holds the value given is left alone ' +
        'and not counted as changed; one holding a different value is overwritten. If ' +
        'any value is refused nothing is written. Answers with the notes it reached, how ' +
        'many changed, and any ids it could not find.',
      inputSchema: z.object({
        noteIds: noteIdsSchema,
        fields: fieldsSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteIds, fields }) => {
      if (Object.keys(fields).length === 0) {
        return toolError('Nothing to do: name at least one field and the value to set.');
      }
      // Names resolve against the notebook the notes are in, which only a note can say.
      // An update that writes nothing is the one call that says which of the ids are
      // live notes, so the first of them is read, rather than reading ids that may not exist.
      const { matched } = await notes.updateMany(noteIds, {});
      const first = matched[0] ? await notes.get(matched[0]) : null;
      if (!first) return jsonResult({ noteIds: [], changed: 0, missing: noteIds });
      const defs = first.notebookId ? ((await notes.listFields(first.notebookId)) ?? []) : [];
      const resolved = resolveFieldNames(fields, defs, [], first.notebook ?? null);
      if ('error' in resolved) return toolError(resolved.error);
      try {
        // The store checks that every note is in the notebook those fields belong to, and
        // names the one that is not; its answer is passed on as it is.
        const done = await notes.updateMany(noteIds, { fields: resolved.patch });
        return jsonResult({
          noteIds: done.matched,
          changed: done.changed.length,
          missing: noteIds.filter((id) => !done.matched.includes(id)),
        });
      } catch (err) {
        if (err instanceof InvalidFieldValue) return toolError(`${err.fieldName} ${err.message}.`);
        throw err;
      }
    },
  );

  /*
     Tags are addressed by name here, as every other tool does, and resolved to the id the
     repo wants from `listTags`. That list is live notes only, so a tag whose every note is
     in the trash is "no such tag" to these two — the same answer list_tags gives, which is
     what the assistant has just read.
  */
  server.registerTool(
    'rename_tag',
    {
      title: 'Rename or merge a tag',
      description:
        'Rename a tag everywhere it is used. The current name matches exactly, case ' +
        'included; list_tags has the spellings. If another tag already has the new name the ' +
        'call is refused, since the two would become one: pass merge:true to fold this tag ' +
        'into that one, so every note that carried it carries the other instead. A merge ' +
        'cannot be undone, so confirm it with the person first. Notes\' own dates do not ' +
        'change.',
      inputSchema: z.object({
        tag: tagNameSchema.describe('The tag to rename, by its current name.'),
        name: tagNameSchema.describe('The new name.'),
        merge: z
          .boolean()
          .default(false)
          .describe('Fold the tag into the existing one with the new name instead of refusing.'),
      }),
      // Destructive for the merge, which cannot be taken back, though a plain rename can:
      // the hint is per tool, and `update_notebook_field` settles it the same way.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ tag, name, merge }) => {
      const existing = (await notes.listTags()).find((t) => t.name === tag);
      if (!existing) return notFound('tag', tag);
      const result = await notes.renameTag(existing.id, name, { merge });
      if (result === 'missing') return notFound('tag', tag);
      if (result === 'conflict') {
        return toolError(
          `A tag called "${name}" already exists, so renaming "${tag}" to it would merge the ` +
            'two. Pass merge:true to fold this tag into it: every note carrying it will carry ' +
            `"${name}" instead, and that cannot be undone. Or choose another name.`,
        );
      }
      return jsonResult({ from: tag, name: result.name, merged: result.merged, notes: existing.count });
    },
  );

  server.registerTool(
    'delete_tag',
    {
      title: 'Delete a tag',
      description:
        'Delete a tag by its exact name, taking it off every note that carries it. The notes ' +
        'themselves stay, with their other tags; only the label goes, and it cannot be ' +
        'brought back except by tagging again, so confirm it with the person first, saying ' +
        'how many notes carry it (list_tags has the count). Answers with how many notes ' +
        'carried it.',
      inputSchema: z.object({ tag: tagNameSchema.describe('The tag to delete, by name.') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ tag }) => {
      // The count is read first, since the delete is what removes the thing counted.
      const existing = (await notes.listTags()).find((t) => t.name === tag);
      if (!existing) return notFound('tag', tag);
      if (!(await notes.deleteTag(existing.id))) return notFound('tag', tag);
      return jsonResult({ tag, deleted: true, notes: existing.count });
    },
  );

  server.registerTool(
    'move_notes',
    {
      title: 'Move notes to a notebook',
      description:
        'File one or more notes into a notebook, or out of every notebook with null. The ' +
        'name matches an existing notebook whatever its case, and one that does not exist ' +
        'is created. Custom field values stay on the note: those from the notebook it left ' +
        'still show on get_note and apply again if it moves back. Answers with the notes ' +
        'it reached, how many actually moved, and any ids it could not find.',
      inputSchema: z.object({
        noteIds: noteIdsSchema,
        notebook: notebookSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteIds, notebook }) => {
      const target = normalizeNotebook(notebook) ?? null;
      const { matched, changed } = await notes.updateMany(noteIds, { notebook: target });
      // The notebook as stored, which is the name the assistant will see everywhere else:
      // a request for "coupons" lands in an existing "Coupons", and the answer says so.
      const first = matched[0] ? await notes.get(matched[0]) : null;
      return jsonResult({
        notebook: first ? (first.notebook ?? null) : target,
        noteIds: matched,
        changed: changed.length,
        missing: noteIds.filter((id) => !matched.includes(id)),
      });
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

  /*
     The same two verbs over a set. Still nothing that deletes permanently — the trash is
     as far as an assistant can go, and a set of ids does not change that.
  */
  server.registerTool(
    'delete_notes',
    {
      title: 'Move several notes to the trash',
      description:
        'Trash several notes at once. Reversible, as delete_note is: they stay in the trash ' +
        'until someone empties it, and restore_notes brings them back. Answers with the ' +
        'notes it trashed and any ids it could not find or that were already in the trash.',
      inputSchema: z.object({ noteIds: noteIdsSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteIds }) => {
      const trashed = await notes.removeMany(noteIds);
      return jsonResult({
        noteIds: trashed,
        missing: noteIds.filter((id) => !trashed.includes(id)),
      });
    },
  );

  server.registerTool(
    'restore_notes',
    {
      title: 'Restore several notes from the trash',
      description:
        'Bring several trashed notes back at once. Answers with the notes it restored and ' +
        'any ids it could not find in the trash.',
      inputSchema: z.object({ noteIds: noteIdsSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteIds }) => {
      const restored = await notes.restoreMany(noteIds);
      return jsonResult({
        noteIds: restored,
        missing: noteIds.filter((id) => !restored.includes(id)),
      });
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
    'update_notebook',
    {
      title: 'Update a notebook',
      description:
        'Change a notebook by id: its name, its purpose, its emoji, or any of them. Get the ' +
        'id from list_notebooks. The purpose is a sentence saying what belongs in the notebook ' +
        'and, as helpfully, what does not (e.g. "Things I want to buy someday; not receipts or ' +
        'purchases"). It is shown to the person and read by auto-fill when it decides where ' +
        'a note belongs, so it is what keeps notes out of a notebook whose name alone would ' +
        'mislead. The emoji is a single emoji (e.g. "🧾") drawn in place of the notebook icon ' +
        'wherever the notebook is listed. Pass purpose:null or emoji:null to clear one. Omit a ' +
        'field to leave it unchanged.',
      inputSchema: z.object({
        notebookId: z.string().min(1),
        name: notebookNameSchema.optional(),
        purpose: notebookPurposeSchema.optional(),
        emoji: notebookEmojiSchema.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ notebookId, name, purpose, emoji }) => {
      if (name === undefined && purpose === undefined && emoji === undefined) {
        return toolError('Give a name, a purpose or an emoji to change.');
      }
      const outcome = await notes.updateNotebook(notebookId, { name, purpose, emoji });
      if (outcome === 'missing') return notFound('notebook', notebookId);
      if (outcome === 'conflict') return toolError(`A notebook called "${name}" already exists.`);
      return jsonResult({
        id: notebookId,
        ...(name !== undefined && { name }),
        ...(purpose !== undefined && { purpose }),
        ...(emoji !== undefined && { emoji }),
      });
    },
  );

  server.registerTool(
    'delete_notebook',
    {
      title: 'Delete a notebook',
      description:
        'Delete a notebook by id; get the id from list_notebooks. By default its notes are ' +
        'kept and filed in no notebook. With trashNotes:true its live notes go to the trash ' +
        'instead, where restore_notes brings them back, filed in no notebook, so no note is ' +
        'destroyed either way. The notebook itself, its purpose, emoji and field definitions ' +
        'are gone and cannot be recovered, so confirm it with the person first, naming the ' +
        'notebook and how many notes it holds; the values the notes hold in those fields ' +
        'stay on the notes and still show on get_note, labelled with the notebook they came ' +
        'from. Prefer move_notes to another notebook first when the notes belong somewhere. ' +
        'Answers with the notebook and how many notes were unfiled or trashed.',
      inputSchema: z.object({
        notebookId: z.string().min(1),
        trashNotes: z
          .boolean()
          .default(false)
          .describe('Move the notebook\'s notes to the trash instead of leaving them unfiled.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ notebookId, trashNotes }) => {
      // Named and counted before the delete, which is what removes the row they come from.
      const { notebooks } = await notes.notebooksOverview();
      const notebook = notebooks.find((nb) => nb.id === notebookId);
      if (!notebook) return notFound('notebook', notebookId);
      if (!(await notes.deleteNotebook(notebookId, { trashNotes }))) {
        return notFound('notebook', notebookId);
      }
      return jsonResult({
        id: notebookId,
        name: notebook.name,
        deleted: true,
        [trashNotes ? 'trashed' : 'unfiled']: notebook.count,
      });
    },
  );

  /**
   * Field definitions can be made and changed here but not deleted or reordered. Deleting
   * one takes every value with it, and that is the line these tools hold: no note, and
   * nothing a note holds, is destroyed here. A label or a container can be — delete_tag,
   * a tag merge and delete_notebook cannot be undone — but the notes and their values
   * come through each of those, where a deleted field's values would not. That is worth
   * more than the symmetry. Order is a display concern for the person, not the model.
   */
  server.registerTool(
    'create_notebook_field',
    {
      title: 'Add a custom field to a notebook',
      description:
        'Define a field on a notebook, so notes in it can carry a value under that name. ' +
        `Types: ${FIELD_TYPES.join(', ')}. A select or multiselect needs its options. A number ` +
        'may carry a currency, which draws its values as money, or a scale, which makes it ' +
        'a rating drawn as stars; not both. Get the notebook id from list_notebooks; set ' +
        'values with create_note or update_note.',
      inputSchema: z.object({
        notebookId: z.string().min(1),
        name: fieldNameSchema,
        type: fieldTypeSchema,
        options: fieldOptionsSchema.optional().describe('For select and multiselect: the allowed values.'),
        currency: currencySchema
          .optional()
          .describe('For number: an ISO 4217 code such as USD, so values read as amounts.'),
        scale: fieldScaleSchema
          .optional()
          .describe(
            `For number: makes it a rating from 1 to max (${MIN_RATING_MAX} to ` +
              `${MAX_RATING_MAX}), in whole steps (step 1) or halves (step 0.5).`,
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ notebookId, name, type, options, currency, scale }) => {
      // Refused rather than passed on: the repo keeps a scale only on a number and drops a
      // currency beside one, which is right for the editor's patches but would leave a
      // model believing it made a rating, or money, that it did not.
      if (scale && type !== 'number') return toolError('Only a number field can have a scale.');
      if (scale && currency) return toolError('A rating cannot also be a currency.');
      const result = await notes.createField(notebookId, {
        name,
        type,
        options: options ?? [],
        scale: scale ?? null,
        currency: currency ?? null,
      });
      if (result === 'missing') return notFound('notebook', notebookId);
      if (result === 'conflict') {
        return toolError(`This notebook already has a field called "${name}".`);
      }
      if (result === 'full') return toolError('This notebook has as many fields as it can hold.');
      return jsonResult(result);
    },
  );

  server.registerTool(
    'update_notebook_field',
    {
      title: 'Rename or retype a custom field',
      description:
        'Change a field\'s name, type, or the options of a select or multiselect. Omit any ' +
        'of them to leave it unchanged. Options replace the whole list rather than adding ' +
        'to it: to add one, send every current option (list_notebooks has them) with the ' +
        'new one, in the order they should show. An option left out leaves the list, but ' +
        'notes that hold it keep their value; only new choices of it are refused until it ' +
        'is sent again. Changing the type converts the values notes already hold; any ' +
        'value that cannot be read as the new type is cleared, and the result says how ' +
        'many were. Changing to select or multiselect makes the existing values the ' +
        'options. A currency on a number is display only: setting or clearing one changes ' +
        'no value.',
      inputSchema: z.object({
        notebookId: z.string().min(1),
        fieldId: z.string().uuid(),
        name: fieldNameSchema.optional(),
        type: fieldTypeSchema.optional(),
        options: fieldOptionsSchema
          .optional()
          .describe('For select and multiselect: the complete list, which replaces the current one.'),
        currency: currencySchema
          .nullable()
          .optional()
          .describe('For number: an ISO 4217 code such as USD, or null to show a plain number.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ notebookId, fieldId, name, type, options, currency }) => {
      const result = await notes.updateField(notebookId, fieldId, { name, type, options, currency });
      if (result === 'missing') return notFound('field', fieldId);
      if (result === 'conflict') {
        return toolError(`This notebook already has a field called "${name}".`);
      }
      return jsonResult(result);
    },
  );
}

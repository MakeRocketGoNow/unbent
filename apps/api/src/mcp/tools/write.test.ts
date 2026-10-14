import { describe, expect, it } from 'vitest';
import { InvalidFieldValue, type FieldDef, type NoteFieldValue } from '@unbent/shared';
import { appLinks } from '../../lib/app-links.js';
import { registerWriteTools } from './write.js';
import type { NotesRepo } from '../../lib/notes-repo.js';

/**
 * These exercise the one piece of real logic in the write tools: deciding whether a
 * find-and-replace is safe to perform.
 *
 * That decision is worth testing on its own because both of its failure modes are silent if
 * they go wrong. A `find` that matches nothing must not report success, and one that matches
 * twice must not pick one — an assistant editing a note it cannot see is relying on the
 * server to refuse rather than guess.
 */

interface Registered {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  }>;
}

/** A self-hosted instance's address, so a link that ignored it would show. */
const APP_URL = 'https://notes.example.com';

/** Collects the tools instead of serving them, so a handler can be called directly. */
function collect(notes: NotesRepo): Map<string, Registered['handler']> {
  const tools = new Map<string, Registered['handler']>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Registered['handler']) {
      tools.set(name, handler);
      return {} as never;
    },
  };
  registerWriteTools(server as never, notes, appLinks(APP_URL));
  return tools;
}

/** A repo holding one note in memory, with only the methods these tools reach for. */
function fakeNotes(
  body: string,
  opts: { fields?: FieldDef[]; existing?: NoteFieldValue[]; notebook?: { id: string; name: string } } = {},
) {
  const note = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Test',
    body,
    tags: [] as string[],
    notebook: opts.notebook?.name ?? null,
    notebookId: opts.notebook?.id ?? null,
    ...(opts.existing ? { fields: opts.existing } : {}),
    createdAt: 0,
    updatedAt: 0,
  };
  /** What the last update asked for, so a test can see the ids the names resolved to. */
  const patches: Array<Record<string, unknown>> = [];
  return {
    note,
    patches,
    repo: {
      get: async (id: string) => (id === note.id ? { ...note } : null),
      listNotebooks: async () => (opts.notebook ? [{ ...opts.notebook, count: 1, fields: 0 }] : []),
      listFields: async (notebookId: string) =>
        notebookId === opts.notebook?.id ? (opts.fields ?? []) : null,
      update: async (
        id: string,
        patch: { body?: string; fields?: Record<string, unknown>; ifUpdatedAt?: number },
      ) => {
        if (id !== note.id) return null;
        patches.push(patch);
        if (patch.ifUpdatedAt !== undefined && patch.ifUpdatedAt !== note.updatedAt) return { stale: { ...note } };
        if (patch.fields?.['bad-value']) throw new InvalidFieldValue('Amount', 'must be a number');
        if (patch.body !== undefined) note.body = patch.body;
        note.updatedAt += 1;
        return { ...note };
      },
      appendToBody: async (id: string, markdown: string) => {
        if (id !== note.id) return false;
        note.body = `${note.body}\n${markdown}`;
        return true;
      },
    } as unknown as NotesRepo,
  };
}

const noteId = '11111111-1111-4111-8111-111111111111';

describe('edit_note', () => {
  it('replaces text that appears exactly once', async () => {
    const { note, repo } = fakeNotes('Buy milk\nBuy bread');
    const edit = collect(repo).get('edit_note')!;

    const result = await edit({ noteId, mode: 'replace', find: 'Buy milk', content: 'Buy oat milk' });

    expect(result.isError).toBeFalsy();
    expect(note.body).toBe('Buy oat milk\nBuy bread');
  });

  it('refuses text that is not there, rather than reporting a change it did not make', async () => {
    const { note, repo } = fakeNotes('Buy milk');
    const edit = collect(repo).get('edit_note')!;

    const result = await edit({ noteId, mode: 'replace', find: 'Buy cheese', content: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('does not appear');
    expect(note.body).toBe('Buy milk');
  });

  it('refuses an ambiguous match and says how many there were', async () => {
    const { note, repo } = fakeNotes('Buy milk\nBuy bread\nBuy eggs');
    const edit = collect(repo).get('edit_note')!;

    const result = await edit({ noteId, mode: 'replace', find: 'Buy ', content: 'Get ' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('appears 3 times');
    expect(note.body).toBe('Buy milk\nBuy bread\nBuy eggs');
  });

  it('deletes the matched span when content is empty', async () => {
    const { note, repo } = fakeNotes('Keep this\nDrop this\n');
    const edit = collect(repo).get('edit_note')!;

    const result = await edit({ noteId, mode: 'replace', find: 'Drop this\n', content: '' });

    expect(result.isError).toBeFalsy();
    expect(note.body).toBe('Keep this\n');
  });

  it('writes dollar signs in the content literally', async () => {
    // `$'`, `$&` and `$$` are replacement patterns to String.replace; in a note they are
    // shell snippets and prices, and must land as typed.
    const { note, repo } = fakeNotes('Run: TODO\nThen done');
    const edit = collect(repo).get('edit_note')!;

    const content = "echo '$' costs $$5 ($&)";
    const result = await edit({ noteId, mode: 'replace', find: 'TODO', content });

    expect(result.isError).toBeFalsy();
    expect(note.body).toBe(`Run: ${content}\nThen done`);
  });

  it('needs a find argument to replace anything', async () => {
    const { repo } = fakeNotes('anything');
    const edit = collect(repo).get('edit_note')!;

    const result = await edit({ noteId, mode: 'replace', content: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('needs a find argument');
  });

  it('reports a missing note rather than throwing', async () => {
    const { repo } = fakeNotes('anything');
    const edit = collect(repo).get('edit_note')!;

    const result = await edit({
      noteId: '22222222-2222-4222-8222-222222222222',
      mode: 'append',
      content: 'x',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No such note');
  });

  it('prepends above the existing body, leaving it intact', async () => {
    const { note, repo } = fakeNotes('Existing.');
    const edit = collect(repo).get('edit_note')!;

    await edit({ noteId, mode: 'prepend', content: '# Heading' });

    expect(note.body).toBe('# Heading\n\nExisting.');
  });

  it('refuses rather than overwrite a save that landed between its read and its write', async () => {
    const { note, repo } = fakeNotes('Buy milk');
    // The editor's autosave, arriving after edit_note has read the body.
    const get = repo.get.bind(repo);
    repo.get = async (id: string) => {
      const read = await get(id);
      note.body = 'Buy milk and eggs';
      note.updatedAt += 1;
      return read;
    };
    const edit = collect(repo).get('edit_note')!;

    const result = await edit({ noteId, mode: 'replace', find: 'Buy milk', content: 'Buy oat milk' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('changed after you read it');
    // The current text goes back with the refusal, so the retry needs no extra read.
    expect(result.content[0]?.text).toContain('Buy milk and eggs');
    expect(note.body).toBe('Buy milk and eggs');
  });
});

describe('update_note with ifUpdatedAt', () => {
  it('writes when the note is the copy that was read, and refuses once it has moved on', async () => {
    const { note, repo } = fakeNotes('Original');
    const update = collect(repo).get('update_note')!;
    const read = new Date(note.updatedAt).toISOString();

    const first = await update({ noteId, body: 'First', ifUpdatedAt: read });
    expect(first.isError).toBeFalsy();
    expect(note.body).toBe('First');

    // The same read, used again: the note has been saved since.
    const second = await update({ noteId, body: 'Second', ifUpdatedAt: read });
    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).toContain('changed after you read it');
    expect(note.body).toBe('First');

    // Without the precondition, the write is unconditional, as it always was.
    const third = await update({ noteId, body: 'Third' });
    expect(third.isError).toBeFalsy();
    expect(note.body).toBe('Third');
  });
});

/**
 * Field values arrive by name, because names are what list_notebooks showed the model and
 * what a person calls them. The mapping to ids is the logic worth pinning: it must not
 * care about case, it must reach a value left over from another notebook, and an unknown
 * name has to come back as an error that says what the real names are.
 */
describe('update_note with custom fields', () => {
  const notebook = { id: 'nb-1', name: 'Receipts' };
  const fields: FieldDef[] = [
    { id: '22222222-2222-4222-8222-222222222222', notebookId: 'nb-1', name: 'Merchant', type: 'text', options: [], scale: null, currency: null, position: 0 },
    { id: 'bad-value', notebookId: 'nb-1', name: 'Amount', type: 'number', options: [], scale: null, currency: null, position: 1 },
  ];
  const leftover: NoteFieldValue = {
    fieldId: '33333333-3333-4333-8333-333333333333',
    name: 'Store',
    type: 'text',
    value: 'Old',
    notebookId: 'nb-0',
    notebook: 'Coupons',
  };

  it('resolves names to ids without regard to case, including a leftover value', async () => {
    const { repo, patches } = fakeNotes('x', { notebook, fields, existing: [leftover] });
    const update = collect(repo).get('update_note')!;

    const result = await update({ noteId, fields: { merchant: 'Acme', STORE: null } });

    expect(result.isError).toBeFalsy();
    expect(patches[0]?.['fields']).toEqual({
      '22222222-2222-4222-8222-222222222222': 'Acme',
      '33333333-3333-4333-8333-333333333333': null,
    });
  });

  it('refuses an unknown name and lists the ones that exist', async () => {
    const { repo, patches } = fakeNotes('x', { notebook, fields, existing: [leftover] });
    const update = collect(repo).get('update_note')!;

    const result = await update({ noteId, fields: { Vendor: 'Acme' } });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('"Vendor"');
    expect(result.content[0]!.text).toContain('Receipts');
    expect(result.content[0]!.text).toContain('Merchant, Amount, Store');
    expect(patches).toHaveLength(0);
  });

  it('reports a value the field cannot hold as an error naming the field', async () => {
    const { repo } = fakeNotes('x', { notebook, fields });
    const update = collect(repo).get('update_note')!;

    const result = await update({ noteId, fields: { Amount: 'twelve' } });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Amount must be a number.');
  });

  it('explains that an unfiled note has no fields to set', async () => {
    const { repo } = fakeNotes('x');
    const update = collect(repo).get('update_note')!;

    const result = await update({ noteId, fields: { Merchant: 'Acme' } });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('a note in no notebook');
    expect(result.content[0]!.text).toContain('no fields yet');
  });
});

/*
 * The tools that take several notes: one batch call each, and an answer that names the
 * ids the batch could not reach rather than dropping them.
 */
describe('the batch tools', () => {
  const other = '22222222-2222-4222-8222-222222222222';

  function batchRepo() {
    const calls: Array<{ method: string; ids: string[]; patch?: unknown }> = [];
    const known = new Set([noteId]);
    const only = (ids: string[]) => ids.filter((id) => known.has(id));
    const repo = {
      get: async (id: string) => (known.has(id) ? { id, notebook: 'Coupons', tags: ['deals'] } : null),
      updateMany: async (ids: string[], patch: unknown) => {
        calls.push({ method: 'updateMany', ids, patch });
        return { matched: only(ids), changed: only(ids) };
      },
      removeMany: async (ids: string[]) => {
        calls.push({ method: 'removeMany', ids });
        return only(ids);
      },
      restoreMany: async (ids: string[]) => {
        calls.push({ method: 'restoreMany', ids });
        return only(ids);
      },
    } as unknown as NotesRepo;
    return { calls, repo };
  }

  const answer = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

  it('files a set in one batch and names the ids it could not find', async () => {
    const { calls, repo } = batchRepo();
    const move = collect(repo).get('move_notes')!;

    const result = answer(await move({ noteIds: [noteId, other], notebook: 'coupons' }));

    // `by` is how the store knows to keep a version even inside the typing window: an
    // assistant's batch is exactly the change someone may want to undo.
    expect(calls).toEqual([{ method: 'updateMany', ids: [noteId, other], patch: { notebook: 'coupons', by: 'assistant' } }]);
    // The name as stored, not as typed.
    expect(result).toEqual({
      notebook: 'Coupons',
      notebookUrl: `${APP_URL}/notes?notebook=Coupons`,
      noteIds: [noteId],
      urls: { [noteId]: `${APP_URL}/notes/${noteId}` },
      changed: 1,
      missing: [other],
    });
  });

  it('treats the unfiled sentinel as no notebook', async () => {
    const { calls, repo } = batchRepo();
    await collect(repo).get('move_notes')!({ noteIds: [noteId], notebook: '[unfiled]' });
    expect(calls[0]?.patch).toEqual({ notebook: null, by: 'assistant' });
  });

  it('adds and removes tags in one batch, and refuses a call that names neither', async () => {
    const { calls, repo } = batchRepo();
    const tag = collect(repo).get('update_note_tags')!;

    const result = answer(await tag({ noteIds: [noteId, other], add: ['later'], remove: ['deals'] }));
    expect(calls[0]).toEqual({
      method: 'updateMany',
      ids: [noteId, other],
      patch: { addTags: ['later'], removeTags: ['deals'], by: 'assistant' },
    });
    expect(result).toEqual({
      noteIds: [noteId],
      urls: { [noteId]: `${APP_URL}/notes/${noteId}` },
      changed: 1,
      missing: [other],
    });

    const refused = await tag({ noteIds: [noteId], add: [], remove: [] });
    expect(refused.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('trashes and restores a set, reporting what it could not reach', async () => {
    const { calls, repo } = batchRepo();
    const tools = collect(repo);

    // A trashed note opens in the trash, not the list it left.
    expect(answer(await tools.get('delete_notes')!({ noteIds: [noteId, other] }))).toEqual({
      noteIds: [noteId],
      urls: { [noteId]: `${APP_URL}/trash/${noteId}` },
      missing: [other],
    });
    expect(answer(await tools.get('restore_notes')!({ noteIds: [other] }))).toEqual({
      noteIds: [],
      urls: {},
      missing: [other],
    });
    expect(calls.map((c) => c.method)).toEqual(['removeMany', 'restoreMany']);
  });
});

/*
 * A rating is a number with a scale. The repo drops a scale it cannot keep, so the tool
 * refuses those instead: a model told "created" must have made the rating it asked for.
 */
describe('create_notebook_field with a scale', () => {
  function fieldRepo() {
    const created: unknown[] = [];
    const repo = {
      createField: async (_notebookId: string, input: Record<string, unknown>) => {
        created.push(input);
        return { id: 'f1', ...input };
      },
    } as unknown as NotesRepo;
    return { created, create: collect(repo).get('create_notebook_field')! };
  }

  it('passes a scale through, making the number a rating', async () => {
    const { created, create } = fieldRepo();
    const result = await create({
      notebookId: 'nb',
      name: 'Rating',
      type: 'number',
      scale: { max: 5, step: 0.5 },
    });
    expect(result.isError).toBeFalsy();
    expect(created).toEqual([
      { name: 'Rating', type: 'number', options: [], scale: { max: 5, step: 0.5 }, currency: null },
    ]);
  });

  it('leaves a plain number unscaled', async () => {
    const { created, create } = fieldRepo();
    await create({ notebookId: 'nb', name: 'Amount', type: 'number', currency: 'USD' });
    expect(created).toEqual([{ name: 'Amount', type: 'number', options: [], scale: null, currency: 'USD' }]);
  });

  it('refuses a scale on anything but a number, and beside a currency', async () => {
    const { created, create } = fieldRepo();
    const onText = await create({ notebookId: 'nb', name: 'Mood', type: 'text', scale: { max: 5, step: 1 } });
    expect(onText.isError).toBe(true);
    expect(onText.content[0]!.text).toContain('Only a number');

    const both = await create({
      notebookId: 'nb',
      name: 'Price',
      type: 'number',
      scale: { max: 5, step: 1 },
      currency: 'USD',
    });
    expect(both.isError).toBe(true);
    expect(both.content[0]!.text).toContain('cannot also be a currency');
    expect(created).toHaveLength(0);
  });
});

/*
 * Tags are named by the model and addressed by id in the repo, so the lookup between the
 * two is the logic here: without case, as the store finds a tag (MAK-127), answering with
 * the stored spelling, and a refusal that says what a merge costs before it is asked for.
 */
describe('rename_tag and delete_tag', () => {
  function tagRepo(renamed: 'ok' | 'conflict' | 'missing' = 'ok') {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const repo = {
      listTags: async () => [
        { id: 'tag-1', name: 'Receipts', count: 4 },
        { id: 'tag-2', name: 'Café', count: 1 },
      ],
      renameTag: async (id: string, name: string, opts: unknown) => {
        calls.push({ method: 'renameTag', args: [id, name, opts] });
        if (renamed === 'ok') return { id, name, merged: false };
        return renamed;
      },
      deleteTag: async (id: string) => {
        calls.push({ method: 'deleteTag', args: [id] });
        return true;
      },
    } as unknown as NotesRepo;
    return { calls, tools: collect(repo) };
  }

  const answer = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

  it('renames by name in any case, and answers with the spelling it renamed', async () => {
    const { calls, tools } = tagRepo();
    const result = answer(await tools.get('rename_tag')!({ tag: 'RECEIPTS', name: 'Bills', merge: false }));
    expect(calls).toEqual([{ method: 'renameTag', args: ['tag-1', 'Bills', { merge: false }] }]);
    expect(result).toEqual({ from: 'Receipts', name: 'Bills', merged: false, notes: 4 });
  });

  it('refuses a rename onto an existing name and says what merge:true would do', async () => {
    const { tools } = tagRepo('conflict');
    const result = await tools.get('rename_tag')!({ tag: 'Receipts', name: 'Bills', merge: false });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('merge:true');
    expect(result.content[0]!.text).toContain('cannot be undone');
  });

  it('passes merge through, and reports a tag it does not know', async () => {
    const { calls, tools } = tagRepo();
    await tools.get('rename_tag')!({ tag: 'Receipts', name: 'Bills', merge: true });
    expect(calls[0]?.args[2]).toEqual({ merge: true });

    // Folded as the store folds, ASCII only: CAFÉ is not Café.
    const unknown = await tools.get('rename_tag')!({ tag: 'CAFÉ', name: 'Bills', merge: false });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain('No such tag: CAFÉ');
    expect(calls).toHaveLength(1);
  });

  it('deletes by name in any case and says how many notes carried the tag', async () => {
    const { calls, tools } = tagRepo();
    const result = answer(await tools.get('delete_tag')!({ tag: 'receipts' }));
    expect(calls).toEqual([{ method: 'deleteTag', args: ['tag-1'] }]);
    expect(result).toEqual({ tag: 'Receipts', deleted: true, notes: 4 });

    const unknown = await tools.get('delete_tag')!({ tag: 'Nope' });
    expect(unknown.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('delete_notebook', () => {
  function notebookRepo(deleted = true) {
    const calls: unknown[][] = [];
    const repo = {
      listNotebooks: async () => [{ id: 'nb-1', name: 'Coupons', count: 12 }],
      deleteNotebook: async (...args: unknown[]) => {
        calls.push(args);
        return deleted;
      },
    } as unknown as NotesRepo;
    return { calls, tool: collect(repo).get('delete_notebook')! };
  }

  const answer = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

  it('unfiles the notes by default and says how many and which notebook', async () => {
    const { calls, tool } = notebookRepo();
    const result = answer(await tool({ notebookId: 'nb-1', trashNotes: false }));
    expect(calls).toEqual([['nb-1', { trashNotes: false }]]);
    expect(result).toEqual({ id: 'nb-1', name: 'Coupons', deleted: true, unfiled: 12 });
  });

  it('trashes the notes when asked, and reports them as trashed', async () => {
    const { calls, tool } = notebookRepo();
    const result = answer(await tool({ notebookId: 'nb-1', trashNotes: true }));
    expect(calls).toEqual([['nb-1', { trashNotes: true }]]);
    expect(result).toEqual({ id: 'nb-1', name: 'Coupons', deleted: true, trashed: 12 });
  });

  it('reports a notebook it cannot find without deleting anything', async () => {
    const { calls, tool } = notebookRepo();
    const result = await tool({ notebookId: 'nb-9', trashNotes: false });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

/*
 * One notebook's field names over a set of notes. The store holds the rule that every
 * note is in that notebook; what is pinned here is where the names are resolved from and
 * that the store's refusal reaches the model as text.
 */
describe('update_note_fields', () => {
  const other = '22222222-2222-4222-8222-222222222222';
  const fields: FieldDef[] = [
    { id: 'f-store', notebookId: 'nb-1', name: 'Store', type: 'text', options: [], scale: null, currency: null, position: 0 },
  ];

  type Target = { id: string | null; name: string | null; notes: number; example: string };

  function fieldsRepo(opts: { refuse?: Error; notebooks?: Target[] } = {}) {
    const calls: Array<{ ids: string[]; patch: Record<string, unknown> }> = [];
    const repo = {
      fieldTargets: async (ids: string[]) => {
        const matched = ids.filter((id) => id === noteId);
        const notebooks = matched.length
          ? (opts.notebooks ?? [{ id: 'nb-1', name: 'Coupons', notes: 1, example: noteId }])
          : [];
        return { matched, notebooks, fields: notebooks.length === 1 && notebooks[0]!.id ? fields : [] };
      },
      updateMany: async (ids: string[], patch: Record<string, unknown>) => {
        calls.push({ ids, patch });
        if (opts.refuse) throw opts.refuse;
        const matched = ids.filter((id) => id === noteId);
        return { matched, changed: matched };
      },
    } as unknown as NotesRepo;
    return { calls, tool: collect(repo).get('update_note_fields')! };
  }

  const answer = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

  it('resolves names against the notes\' notebook and writes once, by id', async () => {
    const { calls, tool } = fieldsRepo();
    const result = answer(await tool({ noteIds: [noteId, other], fields: { store: 'Acme' } }));
    expect(calls.map((c) => c.patch)).toEqual([{ fields: { 'f-store': 'Acme' }, by: 'assistant' }]);
    expect(result).toEqual({
      noteIds: [noteId],
      urls: { [noteId]: `${APP_URL}/notes/${noteId}` },
      changed: 1,
      missing: [other],
    });
  });

  it('refuses an unknown name with the notebook\'s real ones, writing nothing', async () => {
    const { calls, tool } = fieldsRepo();
    const result = await tool({ noteIds: [noteId], fields: { Vendor: 'Acme' } });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Its fields are: Store');
    expect(calls).toHaveLength(0);
  });

  it('refuses notes in no notebook by saying so, not by sending the caller to make a field', async () => {
    const { calls, tool } = fieldsRepo({ notebooks: [{ id: null, name: null, notes: 1, example: noteId }] });
    const result = await tool({ noteIds: [noteId], fields: { Store: 'Acme' } });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('in no notebook');
    expect(result.content[0]!.text).toContain('move_notes');
    // The field exists; the note is in the wrong place. Creating a field would not help.
    expect(result.content[0]!.text).not.toContain('create_notebook_field');
    expect(calls).toHaveLength(0);
  });

  it('refuses a set that spans notebooks, naming each with a note of it', async () => {
    const { calls, tool } = fieldsRepo({
      notebooks: [
        { id: 'nb-1', name: 'Coupons', notes: 2, example: noteId },
        { id: null, name: null, notes: 1, example: other },
      ],
    });
    const result = await tool({ noteIds: [noteId, other], fields: { Store: 'Acme' } });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(`"Coupons" (2 notes, such as ${noteId})`);
    expect(result.content[0]!.text).toContain(`no notebook (1 note, such as ${other})`);
    expect(calls).toHaveLength(0);
  });

  it('passes the store\'s refusal on as text, naming the field and the note', async () => {
    const { tool } = fieldsRepo({
      refuse: new InvalidFieldValue('Store', `is not a field of any notebook note ${other} is in`),
    });
    const result = await tool({ noteIds: [noteId, other], fields: { Store: 'Acme' } });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(`Store is not a field of any notebook note ${other} is in.`);
  });

  it('answers with everything missing when no id is a live note', async () => {
    const { calls, tool } = fieldsRepo();
    const result = answer(await tool({ noteIds: [other], fields: { Store: 'Acme' } }));
    expect(result).toEqual({ noteIds: [], urls: {}, changed: 0, missing: [other] });
    expect(calls).toHaveLength(0);
  });

  it('needs at least one field', async () => {
    const { tool } = fieldsRepo();
    expect((await tool({ noteIds: [noteId], fields: {} })).isError).toBe(true);
  });
});

/*
 * The point of `url`: an assistant that creates or changes a note can hand the person a
 * link to it. Pinned on the answers, and on the descriptions, which are what tell the
 * assistant to pass it on.
 */
describe('links in what the write tools return', () => {
  const answer = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

  it('answers create_note with the new note\'s absolute link on this instance', async () => {
    const repo = {
      create: async (input: { id: string; title: string }) => ({
        ...input,
        body: '',
        tags: [],
        notebook: null,
        createdAt: 0,
        updatedAt: 0,
      }),
    } as unknown as NotesRepo;
    const result = answer(await collect(repo).get('create_note')!({ title: 'Coyote vs. Acme', body: '', tags: [] }));
    expect(result.url).toBe(`${APP_URL}/notes/${result.id}`);
    expect(new URL(result.url).origin).toBe(APP_URL);
  });

  it('answers update_note, edit_note and a refused write with the note\'s link', async () => {
    const { note, repo } = fakeNotes('Buy milk');
    const tools = collect(repo);
    const url = `${APP_URL}/notes/${noteId}`;

    expect(answer(await tools.get('update_note')!({ noteId, title: 'Groceries' })).url).toBe(url);
    expect(answer(await tools.get('edit_note')!({ noteId, mode: 'append', content: 'Buy bread' })).url).toBe(url);

    // A stale write sends the note back so the change can be redone; its link comes too.
    const stale = await tools.get('update_note')!({ noteId, title: 'x', ifUpdatedAt: new Date(note.updatedAt - 1).toISOString() });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain(`"url": "${url}"`);
  });

  it('links a note trashed by delete_note to the trash, and a restored one back to the list', async () => {
    const repo = { remove: async () => true, restore: async () => true } as unknown as NotesRepo;
    const tools = collect(repo);
    expect(answer(await tools.get('delete_note')!({ noteId })).url).toBe(`${APP_URL}/trash/${noteId}`);
    expect(answer(await tools.get('restore_note')!({ noteId })).url).toBe(`${APP_URL}/notes/${noteId}`);
  });

  it('answers create_notebook with the notebook\'s link', async () => {
    const repo = { createNotebook: async (name: string) => ({ id: 'nb-1', name }) } as unknown as NotesRepo;
    const result = answer(await collect(repo).get('create_notebook')!({ name: 'Watch Later' }));
    expect(result.url).toBe(`${APP_URL}/notes?notebook=Watch+Later`);
  });

  it('tells the assistant, in each note-changing tool\'s description, to share the link', () => {
    const descriptions = new Map<string, string>();
    const server = {
      registerTool(name: string, config: { description: string }) {
        descriptions.set(name, config.description);
        return {} as never;
      },
    };
    registerWriteTools(server as never, {} as NotesRepo, appLinks(APP_URL));
    for (const name of ['create_note', 'update_note', 'edit_note', 'restore_note']) {
      expect(descriptions.get(name), name).toMatch(/carries url\b.*give it to the person/);
    }
    for (const name of ['update_note_tags', 'update_note_fields', 'move_notes', 'restore_notes']) {
      expect(descriptions.get(name), name).toMatch(/carries urls\b.*give the person those links/);
    }
  });
});

describe('create_notes (MAK-214)', () => {
  const def = (id: string, name: string, type: FieldDef['type'], options: string[] = []): FieldDef => ({
    id,
    notebookId: 'nb-watch',
    name,
    type,
    options,
    scale: null,
    currency: null,
    position: 0,
  });
  const defs = [def('f-type', 'Type', 'select', ['Movie', 'Series']), def('f-year', 'Year', 'number')];

  function batchRepo() {
    const calls: Array<{ inputs: Array<Record<string, unknown>>; opts: unknown }> = [];
    let overviews = 0;
    const repo = {
      notebooksOverview: async () => {
        overviews++;
        return {
          notebooks: [{ id: 'nb-watch', name: 'Acme Screenings' }],
          unfiled: 0,
          fields: [...defs, { ...def('f-other', 'Type', 'text'), notebookId: 'nb-other' }],
        };
      },
      createMany: async (inputs: Array<Record<string, unknown>>, opts: unknown) => {
        calls.push({ inputs, opts });
        return inputs.map((n, i) => ({ id: n['id'] as string, title: n['title'] as string, skipped: i === 1 }));
      },
    } as unknown as NotesRepo;
    return { calls, overviews: () => overviews, tool: collect(repo).get('create_notes')! };
  }

  const make = (over: Record<string, unknown>) => ({ title: '', body: '', tags: [], ...over });

  it('resolves every note\'s fields by name and creates the batch in one call', async () => {
    const { calls, overviews, tool } = batchRepo();
    const result = await tool({
      notes: [
        make({ title: 'Coyote Returns', notebook: 'acme screenings', fields: { type: 'Movie', Year: 1999 } }),
        make({ title: 'Acme: The Series', notebook: 'Acme Screenings', fields: { Type: 'Series' } }),
        make({ title: 'No fields' }),
      ],
      skipExisting: true,
    });
    expect(result.isError).toBeFalsy();
    expect(overviews()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toEqual({ skipExisting: true });
    expect(calls[0]!.inputs[0]!['fields']).toEqual({ 'f-type': 'Movie', 'f-year': 1999 });
    expect(calls[0]!.inputs[2]).not.toHaveProperty('fields');

    const answer = JSON.parse(result.content[0]!.text);
    expect(answer.created).toBe(2);
    expect(answer.skipped).toBe(1);
    expect(answer.notes[0]).toEqual({
      id: calls[0]!.inputs[0]!['id'],
      url: `${APP_URL}/notes/${calls[0]!.inputs[0]!['id']}`,
      title: 'Coyote Returns',
    });
    expect(answer.notes[1].skipped).toBe(true);
  });

  it('asks for no definitions when no note names a field', async () => {
    const { overviews, tool } = batchRepo();
    await tool({ notes: [make({ title: 'A' }), make({ title: 'B', notebook: 'Acme Screenings' })], skipExisting: false });
    expect(overviews()).toBe(0);
  });

  it('refuses the whole batch, naming each note at fault, before writing any of it', async () => {
    const { calls, tool } = batchRepo();
    const result = await tool({
      notes: [
        make({ title: 'Fine', notebook: 'Acme Screenings', fields: { Type: 'Movie' } }),
        make({ title: 'Wrong option', notebook: 'Acme Screenings', fields: { Type: 'Documentary' } }),
        make({ title: 'Wrong name', notebook: 'Acme Screenings', fields: { Rating: 4 } }),
        make({ title: 'No notebook', fields: { Type: 'Movie' } }),
      ],
      skipExisting: false,
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain('Nothing was created: 3 of the 4 notes');
    expect(text).toContain('notes[1] ("Wrong option"): Type');
    expect(text).toContain('notes[2] ("Wrong name"): No field called "Rating"');
    expect(text).toContain('notes[3] ("No notebook")');
    expect(text).not.toContain('notes[0]');
    expect(calls).toHaveLength(0);
  });

  it('refuses a batch whose bodies are too much for one call', async () => {
    const { calls, tool } = batchRepo();
    const body = 'x'.repeat(700_000);
    const result = await tool({ notes: Array.from({ length: 5 }, () => make({ body })), skipExisting: false });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('smaller batches');
    expect(calls).toHaveLength(0);
  });

  it('reports a value the store refused as nothing created', async () => {
    const repo = {
      createMany: async () => {
        throw new InvalidFieldValue('Year', 'must be a number');
      },
    } as unknown as NotesRepo;
    const result = await collect(repo).get('create_notes')!({ notes: [make({ title: 'A' })], skipExisting: false });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Nothing was created: a field changed');
    expect(result.content[0]!.text).toContain('Year must be a number.');
  });
});

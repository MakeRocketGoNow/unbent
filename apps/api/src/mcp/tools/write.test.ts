import { describe, expect, it } from 'vitest';
import { InvalidFieldValue, type FieldDef, type NoteFieldValue } from '@unbent/shared';
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

/** Collects the tools instead of serving them, so a handler can be called directly. */
function collect(notes: NotesRepo): Map<string, Registered['handler']> {
  const tools = new Map<string, Registered['handler']>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Registered['handler']) {
      tools.set(name, handler);
      return {} as never;
    },
  };
  registerWriteTools(server as never, notes);
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

    expect(calls).toEqual([{ method: 'updateMany', ids: [noteId, other], patch: { notebook: 'coupons' } }]);
    // The name as stored, not as typed.
    expect(result).toEqual({ notebook: 'Coupons', noteIds: [noteId], changed: 1, missing: [other] });
  });

  it('treats the unfiled sentinel as no notebook', async () => {
    const { calls, repo } = batchRepo();
    await collect(repo).get('move_notes')!({ noteIds: [noteId], notebook: '[unfiled]' });
    expect(calls[0]?.patch).toEqual({ notebook: null });
  });

  it('adds and removes tags in one batch, and refuses a call that names neither', async () => {
    const { calls, repo } = batchRepo();
    const tag = collect(repo).get('update_note_tags')!;

    const result = answer(await tag({ noteIds: [noteId, other], add: ['later'], remove: ['deals'] }));
    expect(calls[0]).toEqual({
      method: 'updateMany',
      ids: [noteId, other],
      patch: { addTags: ['later'], removeTags: ['deals'] },
    });
    expect(result).toEqual({ noteIds: [noteId], changed: 1, missing: [other] });

    const refused = await tag({ noteIds: [noteId], add: [], remove: [] });
    expect(refused.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('trashes and restores a set, reporting what it could not reach', async () => {
    const { calls, repo } = batchRepo();
    const tools = collect(repo);

    expect(answer(await tools.get('delete_notes')!({ noteIds: [noteId, other] }))).toEqual({
      noteIds: [noteId],
      missing: [other],
    });
    expect(answer(await tools.get('restore_notes')!({ noteIds: [other] }))).toEqual({
      noteIds: [],
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
 * two is the logic here: exact and case-sensitive, because "Receipts" and "receipts" are
 * two tags, and a refusal that says what a merge costs before it is asked for.
 */
describe('rename_tag and delete_tag', () => {
  function tagRepo(renamed: 'ok' | 'conflict' | 'missing' = 'ok') {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const repo = {
      listTags: async () => [
        { id: 'tag-1', name: 'Receipts', count: 4 },
        { id: 'tag-2', name: 'receipts', count: 1 },
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

  it('renames by exact name, resolving it to that tag and not its case-variant', async () => {
    const { calls, tools } = tagRepo();
    const result = answer(await tools.get('rename_tag')!({ tag: 'receipts', name: 'Bills', merge: false }));
    expect(calls).toEqual([{ method: 'renameTag', args: ['tag-2', 'Bills', { merge: false }] }]);
    expect(result).toEqual({ from: 'receipts', name: 'Bills', merged: false, notes: 1 });
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

    const unknown = await tools.get('rename_tag')!({ tag: 'RECEIPTS', name: 'Bills', merge: false });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain('No such tag: RECEIPTS');
    expect(calls).toHaveLength(1);
  });

  it('deletes by exact name and says how many notes carried the tag', async () => {
    const { calls, tools } = tagRepo();
    const result = answer(await tools.get('delete_tag')!({ tag: 'Receipts' }));
    expect(calls).toEqual([{ method: 'deleteTag', args: ['tag-1'] }]);
    expect(result).toEqual({ tag: 'Receipts', deleted: true, notes: 4 });

    const unknown = await tools.get('delete_tag')!({ tag: 'Nope' });
    expect(unknown.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

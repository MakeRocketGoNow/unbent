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
      update: async (id: string, patch: { body?: string; fields?: Record<string, unknown> }) => {
        if (id !== note.id) return null;
        patches.push(patch);
        if (patch.fields?.['bad-value']) throw new InvalidFieldValue('Amount', 'must be a number');
        if (patch.body !== undefined) note.body = patch.body;
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

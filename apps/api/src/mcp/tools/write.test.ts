import { describe, expect, it } from 'vitest';
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
function fakeNotes(body: string) {
  const note = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Test',
    body,
    tags: [] as string[],
    notebook: null,
    createdAt: 0,
    updatedAt: 0,
  };
  return {
    note,
    repo: {
      get: async (id: string) => (id === note.id ? { ...note } : null),
      update: async (id: string, patch: { body?: string }) => {
        if (id !== note.id) return null;
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

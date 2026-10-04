import { describe, expect, it } from 'vitest';
import type { FieldDef } from '@unbent/shared';
import { registerReadTools } from './read.js';
import type { NotesRepo } from '../../lib/notes-repo.js';

/*
 * The read tools are thin over the repo; what is worth pinning is the part that is not:
 * turning the names a model sends into the ids and filters the store takes.
 */

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function collect(notes: NotesRepo): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools.set(name, handler);
      return {} as never;
    },
  };
  registerReadTools(server as never, notes, {} as never);
  return tools;
}

const answer = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

describe('list_notes with field filters', () => {
  const def = (id: string, name: string, type: FieldDef['type']): FieldDef => ({
    id,
    notebookId: 'nb-1',
    name,
    type,
    options: [],
    scale: null,
    currency: null,
    position: 0,
  });
  const fields = [def('f-expires', 'Expires', 'date'), def('f-store', 'Store', 'text')];

  function listRepo() {
    const pages: Array<{ list: Record<string, unknown>; count: Record<string, unknown> | null }> = [];
    const repo = {
      listNotebooks: async () => [{ id: 'nb-1', name: 'Coupons', count: 3, fields: 2 }],
      listFields: async (id: string) => (id === 'nb-1' ? fields : null),
      listPage: async (list: Record<string, unknown>, count: Record<string, unknown> | null) => {
        pages.push({ list, count });
        return { items: [], total: 0 };
      },
    } as unknown as NotesRepo;
    return { pages, list: collect(repo).get('list_notes')! };
  }

  it('resolves names to ids, case-insensitively, for the page and for the count', async () => {
    const { pages, list } = listRepo();

    const result = await list({
      limit: 25,
      notebook: 'coupons',
      fields: [
        { field: 'expires', op: 'lte', value: '2026-12-31' },
        { field: 'STORE', op: 'empty' },
      ],
    });

    expect(result.isError).toBeFalsy();
    const expected = [
      { fieldId: 'f-expires', op: 'lte', value: '2026-12-31' },
      { fieldId: 'f-store', op: 'empty' },
    ];
    expect(pages[0]?.list['fields']).toEqual(expected);
    // The total has to see the same filter as the page, or the header contradicts the rows.
    expect(pages[0]?.count?.['fields']).toEqual(expected);
  });

  it('refuses an unknown field name and lists the notebook\'s real ones', async () => {
    const { pages, list } = listRepo();
    const result = await list({ limit: 25, notebook: 'Coupons', fields: [{ field: 'Vendor', op: 'set' }] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('"Vendor"');
    expect(result.content[0]!.text).toContain('Expires, Store');
    expect(pages).toHaveLength(0);
  });

  it('needs a notebook, since a field name means nothing outside one', async () => {
    const { list } = listRepo();
    for (const notebook of [undefined, '[unfiled]']) {
      const result = await list({ limit: 25, notebook, fields: [{ field: 'Expires', op: 'set' }] });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('need a notebook');
    }
    const missing = await list({ limit: 25, notebook: 'Nope', fields: [{ field: 'Expires', op: 'set' }] });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('No such notebook: Nope');
  });

  it('refuses a value the op cannot use, by the same rule the URL filter applies', async () => {
    const { pages, list } = listRepo();
    const bad = [
      { field: 'Expires', op: 'lte', value: 'next week' },
      { field: 'Store', op: 'eq' },
      { field: 'Store', op: 'set', value: 'Acme' },
    ];
    for (const f of bad) {
      const result = await list({ limit: 25, notebook: 'Coupons', fields: [f] });
      expect(result.isError, JSON.stringify(f)).toBe(true);
    }
    expect(pages).toHaveLength(0);
  });

  it('leaves the filters out entirely when none are given', async () => {
    const { pages, list } = listRepo();
    answer(await list({ limit: 25, notebook: 'Coupons' }));
    expect(pages[0]?.list['fields']).toBeUndefined();
  });
});

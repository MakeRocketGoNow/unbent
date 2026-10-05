import { describe, expect, it } from 'vitest';
import type { FieldDef } from '@unbent/shared';
import { appLinks } from '../../lib/app-links.js';
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

/** A self-hosted instance's address, so a link that ignored it would show. */
const APP_URL = 'https://notes.example.com';

function collect(notes: NotesRepo): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      tools.set(name, handler);
      return {} as never;
    },
  };
  registerReadTools(server as never, notes, {} as never, appLinks(APP_URL), { vision: true });
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
      notebookByName: async (name: string) =>
        name.toLowerCase() === 'coupons' ? { id: 'nb-1', name: 'Coupons', fields } : null,
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

describe('list_tags with a notebook or tags', () => {
  function tagsRepo() {
    const calls: Array<{ method: string; arg?: unknown }> = [];
    const repo = {
      listTags: async () => {
        calls.push({ method: 'listTags' });
        return [{ id: 't1', name: 'Acme', count: 9 }];
      },
      tagCounts: async (filter: unknown) => {
        calls.push({ method: 'tagCounts', arg: filter });
        return [{ id: 't2', name: 'Food', count: 2 }];
      },
    } as unknown as NotesRepo;
    return { calls, tool: collect(repo).get('list_tags')! };
  }

  it('keeps the stored per-tag counts, and the query behind them, when nothing narrows it', async () => {
    const { calls, tool } = tagsRepo();
    expect(answer(await tool({}))).toEqual({ tags: [{ id: 't1', name: 'Acme', count: 9 }] });
    // An empty list narrows nothing, so it must not turn into the walk of a set.
    await tool({ tag: [] });
    expect(calls.map((c) => c.method)).toEqual(['listTags', 'listTags']);
  });

  it('counts within the set when a notebook, tags or both are given', async () => {
    const { calls, tool } = tagsRepo();
    expect(answer(await tool({ notebook: 'Coupons' })).tags).toEqual([{ id: 't2', name: 'Food', count: 2 }]);
    await tool({ tag: ['Acme'] });
    await tool({ notebook: '[unfiled]', tag: ['Acme', 'Food'] });
    expect(calls).toEqual([
      { method: 'tagCounts', arg: { notebook: 'Coupons', tags: undefined } },
      { method: 'tagCounts', arg: { notebook: undefined, tags: ['Acme'] } },
      { method: 'tagCounts', arg: { notebook: '[unfiled]', tags: ['Acme', 'Food'] } },
    ]);
  });
});

describe('list_tags with a notebook that has no tags to show', () => {
  function emptyRepo() {
    const asked: string[] = [];
    const repo = {
      tagCounts: async () => [],
      notebookByName: async (name: string) => {
        asked.push(name);
        return name === 'Coupons' ? { id: 'nb-1', name: 'Coupons', fields: [] } : null;
      },
    } as unknown as NotesRepo;
    return { asked, tool: collect(repo).get('list_tags')! };
  }

  it('says a notebook does not exist rather than that its notes carry no tags', async () => {
    const { tool } = emptyRepo();
    const result = await tool({ notebook: 'Cupons' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('No such notebook: Cupons');
  });

  it('answers an empty list for a real notebook, and for notes in none without asking', async () => {
    const { asked, tool } = emptyRepo();
    expect(answer(await tool({ notebook: 'Coupons' }))).toEqual({ tags: [] });
    expect(answer(await tool({ notebook: '[unfiled]' }))).toEqual({ tags: [] });
    expect(asked).toEqual(['Coupons']);
  });
});

describe('list_notes with untagged', () => {
  function pageRepo() {
    const pages: Array<{ list: Record<string, unknown>; count: Record<string, unknown> | null }> = [];
    const repo = {
      listPage: async (list: Record<string, unknown>, count: Record<string, unknown> | null) => {
        pages.push({ list, count });
        return { items: [], total: 0 };
      },
    } as unknown as NotesRepo;
    return { pages, list: collect(repo).get('list_notes')! };
  }

  it('narrows the page and the total alike', async () => {
    const { pages, list } = pageRepo();
    const result = await list({ limit: 25, untagged: true, notebook: 'Coupons' });
    expect(result.isError).toBeFalsy();
    expect(pages[0]?.list['untagged']).toBe(true);
    expect(pages[0]?.count?.['untagged']).toBe(true);
  });

  it('refuses the pair with tag, which could only ever match nothing', async () => {
    const { pages, list } = pageRepo();
    const result = await list({ limit: 25, untagged: true, tag: ['Acme'] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('cannot be combined with tag');
    expect(pages).toHaveLength(0);
  });

  it('asks for nothing extra when it is off', async () => {
    const { pages, list } = pageRepo();
    await list({ limit: 25, untagged: false, tag: ['Acme'] });
    expect(pages[0]?.list['untagged']).toBeFalsy();
  });
});

describe('list_notes pages', () => {
  const row = {
    id: 'n-1',
    title: 'Acme 10% off',
    createdAt: 1,
    updatedAt: 2,
    tags: ['Deals'],
    notebook: 'Coupons',
    notebookId: 'nb-1',
    excerpt: 'Ten percent off at example.com',
  };

  function pageRepo() {
    const pages: Array<{ list: Record<string, unknown>; count: Record<string, unknown> | null }> = [];
    const repo = {
      listPage: async (list: Record<string, unknown>, count: Record<string, unknown> | null) => {
        pages.push({ list, count });
        return { items: [row], total: count ? 1 : null };
      },
    } as unknown as NotesRepo;
    return { pages, list: collect(repo).get('list_notes')! };
  }

  it('counts on the first page and not on one asked for with a cursor', async () => {
    const { pages, list } = pageRepo();

    expect(answer(await list({ limit: 25, untagged: true })).total).toBe(1);
    expect(pages[0]?.count).not.toBeNull();

    const next = answer(await list({ limit: 25, untagged: true, cursor: 'abc' }));
    expect(pages[1]?.count).toBeNull();
    // Absent rather than null or 0: a walk that read `total: 0` would stop.
    expect('total' in next).toBe(false);
  });

  it('answers a compact page with what a batch write needs to be checked against, and no more', async () => {
    const { pages, list } = pageRepo();
    const result = answer(await list({ limit: 500, compact: true }));
    expect(pages[0]?.list['limit']).toBe(500);
    // The store is told, so it does not read five hundred bodies to throw them away.
    expect(pages[0]?.list['compact']).toBe(true);
    expect(result.notes).toEqual([{ id: 'n-1', title: 'Acme 10% off', notebook: 'Coupons', tags: ['Deals'] }]);
  });

  it('keeps a full page to a hundred', async () => {
    const { pages, list } = pageRepo();
    const result = await list({ limit: 101, compact: false });
    expect(result.isError).toBe(true);
    expect(pages).toHaveLength(0);
  });
});

/*
 * Every note a read tool returns carries the absolute address it opens at, on the
 * instance's own origin, so an assistant can give the person a link rather than an id.
 */
describe('links in what the read tools return', () => {
  const live = {
    id: 'n-1',
    title: 'Acme 10% off',
    createdAt: 1,
    updatedAt: 2,
    tags: [],
    notebook: 'Watch Later',
    notebookId: 'nb-1',
  };

  it('gives each note in a page its link, and a trashed one the trash\'s', async () => {
    const repo = {
      listPage: async () => ({ items: [live, { ...live, id: 'n-2', deletedAt: 3 }], total: 2 }),
    } as unknown as NotesRepo;
    const result = answer(await collect(repo).get('list_notes')!({ limit: 25 }));
    expect(result.notes.map((n: { url: string }) => n.url)).toEqual([
      `${APP_URL}/notes/n-1`,
      `${APP_URL}/trash/n-2`,
    ]);
  });

  it('gives get_note and each search result the note\'s link', async () => {
    const repo = {
      getWithFiles: async (id: string) => (id === live.id ? { note: { ...live, body: '' }, files: [] } : null),
      search: async () => [{ id: 'n-1', title: live.title, updatedAt: 2, snippet: 'Acme' }],
    } as unknown as NotesRepo;
    const tools = collect(repo);
    expect(answer(await tools.get('get_note')!({ noteId: 'n-1' })).url).toBe(`${APP_URL}/notes/n-1`);
    const found = answer(await tools.get('search_notes')!({ query: 'acme', limit: 20 }));
    expect(found.results[0].url).toBe(`${APP_URL}/notes/n-1`);
  });

  it('links each notebook to the note list filtered to it', async () => {
    const repo = {
      notebooksOverview: async () => ({
        notebooks: [{ id: 'nb-1', name: 'Watch Later', count: 1 }],
        unfiled: 0,
        fields: [],
      }),
    } as unknown as NotesRepo;
    const result = answer(await collect(repo).get('list_notebooks')!({}));
    expect(result.notebooks[0].url).toBe(`${APP_URL}/notes?notebook=Watch+Later`);
  });
});

describe('file summaries on get_note and list_notes (MAK-172)', () => {
  const note = { id: 'n-1', title: 'Receipt', createdAt: 1, updatedAt: 2, tags: [], notebook: 'Receipts', notebookId: 'nb-1' };
  const read = { filename: 'receipt.jpg', contentType: 'image/jpeg', read: 'vision', summary: 'Acme Diner receipt — Receipt: $17.27' };
  const waiting = { filename: 'scan.pdf', contentType: 'application/pdf', read: 'pending', summary: null };

  it('gives every file on get_note its status and summary, told whether there is a vision model', async () => {
    const asked: unknown[] = [];
    const repo = {
      getWithFiles: async (_id: string, opts: unknown) => {
        asked.push(opts);
        return { note: { ...note, body: '' }, files: [{ ...read, size: 9 }, { ...waiting, size: 4 }] };
      },
    } as unknown as NotesRepo;
    const tools = new Map<string, Handler>();
    const server = { registerTool: (name: string, _c: unknown, h: Handler) => void tools.set(name, h) };
    registerReadTools(server as never, repo, {} as never, appLinks(APP_URL), { vision: false });
    const result = answer(await tools.get('get_note')!({ noteId: 'n-1' }));
    expect(asked).toEqual([{ vision: false }]);
    expect(result.attachments.map((f: { read: string; summary: string | null }) => [f.read, f.summary])).toEqual([
      ['vision', read.summary],
      ['pending', null],
    ]);
  });

  function listRepo(summaries: Record<string, unknown[]> | undefined) {
    const asked: Array<Record<string, unknown> | undefined> = [];
    const repo = {
      listPage: async (_list: unknown, _count: unknown, opts?: Record<string, unknown>) => {
        asked.push(opts);
        return { items: [note, { ...note, id: 'n-2' }], total: 2, ...(opts?.['summaries'] ? { summaries } : {}) };
      },
    } as unknown as NotesRepo;
    return { asked, list: collect(repo).get('list_notes')! };
  }

  it('lists each note\'s files when asked, an empty list for a note with none, and nothing otherwise', async () => {
    const { asked, list } = listRepo({ 'n-1': [read, waiting] });

    const plain = answer(await list({ limit: 25 }));
    expect(asked[0]?.['summaries']).toBeFalsy();
    expect(plain.notes[0].attachments).toBeUndefined();

    const withFiles = answer(await list({ limit: 25, attachmentSummaries: true }));
    expect(asked[1]).toEqual({ summaries: true, vision: true });
    // Filename, status and summary only: the content type is get_note's.
    expect(withFiles.notes[0].attachments).toEqual([
      { filename: 'receipt.jpg', read: 'vision', summary: read.summary },
      { filename: 'scan.pdf', read: 'pending', summary: null },
    ]);
    expect(withFiles.notes[1].attachments).toEqual([]);
  });

  it('lists ten files a note and counts the rest, which get_note has', async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ ...waiting, filename: `page-${i}.pdf` }));
    const { list } = listRepo({ 'n-1': many });
    const result = answer(await list({ limit: 25, attachmentSummaries: true }));
    expect(result.notes[0].attachments.map((f: { filename: string }) => f.filename)).toEqual(many.slice(0, 10).map((f) => f.filename));
    expect(result.notes[0].moreFiles).toBe(3);
    expect(result.notes[1].moreFiles).toBeUndefined();
  });

  it('refuses summaries on a compact page, which is for hundreds of ids', async () => {
    const { asked, list } = listRepo({});
    const result = await list({ limit: 500, compact: true, attachmentSummaries: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/compact/);
    expect(asked).toEqual([]);
  });
});

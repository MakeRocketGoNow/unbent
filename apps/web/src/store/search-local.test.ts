// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { FeedAttachment, FeedNote, FeedNotebook, FeedTag } from '@unbent/shared';
import { RECENT_NOTES, SearchIndex } from './search-index.js';
import { BUILT, fieldEntryPrefix, noteEntries, searchLocal, stampOf, tagEntries, textPlan } from './search-local.js';
import { openTestSearchDb } from './test-search-db.js';
import type { LocalNote, Snapshot } from './derive.js';

const DAY = 24 * 60 * 60 * 1000;
const note = (id: string, over: Partial<LocalNote> = {}): LocalNote =>
  ({ id, title: '', body: '', tagIds: [], files: [], fields: [], notebookId: null, createdAt: 10 * DAY, updatedAt: 10 * DAY, ...over }) as LocalNote;
const file = (id: string, noteId: string, over: Partial<FeedAttachment> = {}): FeedAttachment => ({
  id,
  noteId,
  filename: `${id}.pdf`,
  contentType: 'application/pdf',
  size: 100,
  hasText: true,
  createdAt: 1,
  ...over,
});

const notebooks: FeedNotebook[] = [
  { id: 'nb-receipts', name: 'Receipts', purpose: null, emoji: null, fieldDefs: [{ id: 'f-vendor', notebookId: 'nb-receipts', name: 'Vendor', type: 'text', position: 0 } as FeedNotebook['fieldDefs'][number]] },
  { id: 'nb-manuals', name: 'Manuals', purpose: null, emoji: null, fieldDefs: [] },
];
const tags: FeedTag[] = [
  { id: 't-garden', name: 'garden' },
  { id: 't-tax', name: 'tax 2025' },
];

/** Indexes a snapshot the way a pass does, with the given files' text. */
async function indexed(snapshot: Snapshot, texts: Record<string, string> = {}) {
  const index = new SearchIndex(await openTestSearchDb());
  const live = [...snapshot.notes].filter((n) => n.deletedAt === undefined).map(noteEntries);
  await index.put('note', live.map((e) => e.note));
  await index.put('field', live.flatMap((e) => e.fields));
  await index.put('tag', tagEntries(snapshot));
  await index.put('file', Object.entries(texts).map(([id, text]) => ({ id, stamp: '', columns: [text] })));
  await index.setMeta(BUILT, '1');
  return index;
}

const library = (notes: LocalNote[], attachments: FeedAttachment[] = []): Snapshot => ({ notes, notebooks, tags, attachments });

describe('searchLocal', () => {
  it('finds a note by a phrase in its body, stemmed, and marks the snippet', async () => {
    const snapshot = library([note('a', { title: 'Tomatoes', body: 'Water the seedlings every morning before the sun is up.' }), note('b', { title: 'Other', body: 'Nothing here.' })]);
    const index = await indexed(snapshot);
    const { results } = await searchLocal({ index, snapshot, query: 'watering seedling' });
    expect(results.map((r) => r.id)).toEqual(['a']);
    expect(results[0]!.snippet).toContain('<<Water>>');
    expect(results[0]!.snippet).toContain('<<seedlings>>');
    // The last term is a prefix, as on the server, so results appear while typing.
    expect((await searchLocal({ index, snapshot, query: 'seedl' })).results.map((r) => r.id)).toEqual(['a']);
    expect((await searchLocal({ index, snapshot, query: '  ' })).results).toEqual([]);
    // What a search box is given is not a query language.
    expect((await searchLocal({ index, snapshot, query: 'water AND "(' })).results).toEqual([]);
  });

  it('ranks a title match over a body match, and note text over a tag, a field and a file', async () => {
    const snapshot = library(
      [
        note('body', { title: 'Shopping', body: 'Remember the invoice for the mower.' }),
        note('title', { title: 'Invoice', body: 'From the hardware shop.' }),
        note('tagged', { title: 'Spring', tagIds: ['t-garden'], tagNames: ['invoice'] }),
        note('field', { title: 'Mower', notebookId: 'nb-receipts', fields: [{ fieldId: 'f-vendor', name: 'Old name', type: 'text', value: 'Invoice Depot', notebookId: 'nb-receipts', notebook: 'Receipts' }] }),
        note('scan', { title: 'Scan 4' }),
      ],
      [file('x1', 'scan', { filename: 'scan-4.pdf' })],
    );
    const index = await indexed(snapshot, { x1: 'INVOICE number 4471 for one lawn mower' });
    const { results } = await searchLocal({ index, snapshot, query: 'invoice' });
    expect(results.map((r) => r.id)).toEqual(['title', 'body', 'tagged', 'field', 'scan']);
    expect(results[2]).toMatchObject({ matchedTag: 'invoice' });
    // The field's name as the definition held has it, not the one the value carried.
    expect(results[3]).toMatchObject({ matchedField: 'Vendor', snippet: '<<Invoice>> Depot' });
    expect(results[4]).toMatchObject({ matchedFile: 'scan-4.pdf' });
    expect(results[4]!.snippet).toContain('<<INVOICE>>');
  });

  it('gives a note one row, from the best tier it matched in', async () => {
    const snapshot = library([note('a', { title: 'Garden plan', body: 'Beds and paths.', tagIds: ['t-garden'] })], [file('x1', 'a')]);
    const index = await indexed(snapshot, { x1: 'garden centre receipt' });
    const { results } = await searchLocal({ index, snapshot, query: 'garden' });
    expect(results).toHaveLength(1);
    expect(results[0]).not.toHaveProperty('matchedTag');
    expect(results[0]).not.toHaveProperty('matchedFile');
  });

  it('applies the list filters: notebook, tags, a field, and a date range on the created day', async () => {
    const snapshot = library([
      note('r1', { title: 'Boiler service', notebookId: 'nb-receipts', tagIds: ['t-tax'], createdAt: 20 * DAY, fields: [{ fieldId: 'f-vendor', name: 'Vendor', type: 'text', value: 'Acme', notebookId: 'nb-receipts', notebook: 'Receipts' }] }),
      note('r2', { title: 'Boiler parts', notebookId: 'nb-receipts', createdAt: 40 * DAY }),
      note('m1', { title: 'Boiler manual', notebookId: 'nb-manuals', createdAt: 20 * DAY }),
      note('u1', { title: 'Boiler notes', createdAt: 20 * DAY }),
      note('gone', { title: 'Boiler quote', notebookId: 'nb-receipts', deletedAt: 5 }),
    ]);
    const index = await indexed(snapshot);
    const ids = async (filter: Parameters<typeof searchLocal>[0]['filter']) => (await searchLocal({ index, snapshot, query: 'boiler', filter })).results.map((r) => r.id).sort();
    expect(await ids({})).toEqual(['m1', 'r1', 'r2', 'u1']);
    expect(await ids({ notebook: 'receipts' })).toEqual(['r1', 'r2']);
    expect(await ids({ tag: ['tax 2025'] })).toEqual(['r1']);
    expect(await ids({ notebook: 'Receipts', field: ['f-vendor:eq:Acme'] })).toEqual(['r1']);
    const day = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
    expect(await ids({ from: day(30), to: day(50) })).toEqual(['r2']);
  });

  it('finds a filtered match however far down the unfiltered ranking it is', async () => {
    const crowd = Array.from({ length: 400 }, (_, i) => note(`n${String(i).padStart(3, '0')}`, { title: 'Receipt receipt receipt' }));
    const snapshot = library([...crowd, note('wanted', { title: 'Long note', body: `${'filler '.repeat(400)} receipt`, notebookId: 'nb-manuals' })]);
    const index = await indexed(snapshot);
    expect((await searchLocal({ index, snapshot, query: 'receipt', filter: { notebook: 'Manuals' } })).results.map((r) => r.id)).toEqual(['wanted']);
    // Unfiltered it is the page the ranking gives, and no more than a page.
    const page = await searchLocal({ index, snapshot, query: 'receipt', limit: 50 });
    expect(page.results).toHaveLength(50);
    expect(page.results.map((r) => r.id)).not.toContain('wanted');
  });

  it('skips an entry whose note has gone since it was indexed, and still fills the page', async () => {
    const all = Array.from({ length: 30 }, (_, i) => note(`n${String(i).padStart(2, '0')}`, { title: `Ledger ${i}` }));
    const index = await indexed(library(all));
    // The library has moved on: most of the notes the index holds are trashed or gone.
    const now = library(all.map((n, i) => (i < 25 ? { ...n, deletedAt: 9 } : n)).filter((_, i) => i !== 3));
    const { results } = await searchLocal({ index, snapshot: now, query: 'ledger', limit: 5 });
    expect(results.map((r) => r.id).sort()).toEqual(['n25', 'n26', 'n27', 'n28', 'n29']);
  });

  it('carries each match’s list row when asked, for a table', async () => {
    const snapshot = library([note('a', { title: 'Kettle', notebookId: 'nb-receipts', tagIds: ['t-tax'] })]);
    const index = await indexed(snapshot);
    const { results } = await searchLocal({ index, snapshot, query: 'kettle', rows: true });
    expect(results[0]).toMatchObject({ note: { id: 'a', title: 'Kettle', notebook: 'Receipts', tags: ['tax 2025'] } });
  });

  it('says what it covered: the files with text in scope, and how many are indexed here', async () => {
    const snapshot = library(
      [note('kept', { notebookId: 'nb-receipts', title: 'Kept' }), note('far', { notebookId: 'nb-manuals', title: 'Far' }), note('bin', { deletedAt: 3 })],
      [file('k1', 'kept'), file('f1', 'far'), file('f2', 'far'), file('unread', 'far', { hasText: false }), file('b1', 'bin')],
    );
    const index = await indexed(snapshot, { k1: 'warranty for the dishwasher' });
    const all = await searchLocal({ index, snapshot, query: 'dishwasher' });
    expect(all.results.map((r) => r.id)).toEqual(['kept']);
    expect(all.coverage).toEqual({ built: true, files: { searched: 1, total: 3 } });
    // Inside the kept notebook everything with text was searched.
    expect((await searchLocal({ index, snapshot, query: 'dishwasher', filter: { notebook: 'Receipts' } })).coverage.files).toEqual({ searched: 1, total: 1 });
    const none = await searchLocal({ index, snapshot, query: 'dishwasher', filter: { notebook: 'Manuals' } });
    expect(none.results).toEqual([]);
    expect(none.coverage.files).toEqual({ searched: 0, total: 2 });
    await index.setMeta(BUILT, null);
    expect((await searchLocal({ index, snapshot, query: 'x' })).coverage.built).toBe(false);
  });
});

describe('SearchIndex', () => {
  it('replaces an entry put again, drops one, and keeps the rest', async () => {
    const index = new SearchIndex(await openTestSearchDb());
    await index.put('note', [
      { id: 'a', stamp: '1', columns: ['Alpha', 'first'] },
      { id: 'b', stamp: '1', columns: ['Beta', 'second'] },
    ]);
    await index.put('note', [{ id: 'a', stamp: '2', columns: ['Alpha', 'rewritten'] }]);
    expect(await index.stamps('note')).toEqual(new Map([['a', '2'], ['b', '1']]));
    expect(await index.candidates('note', '"first"*', -1)).toEqual([]);
    expect((await index.candidates('note', '"rewritten"*', -1)).map((c) => c.id)).toEqual(['a']);
    await index.drop('note', ['a', 'never']);
    expect(await index.stamps('note', ['a', 'b'])).toEqual(new Map([['b', '1']]));
    expect(await index.candidates('note', '"alpha"*', -1)).toEqual([]);
    expect(await index.held('note', ['a', 'b'])).toBe(1);
  });

  it('finds a note’s field entries by its prefix and nobody else’s', async () => {
    const index = new SearchIndex(await openTestSearchDb());
    const a = noteEntries(note('n1', { fields: [{ fieldId: 'f1', name: 'V', type: 'text', value: 'x', notebookId: 'nb', notebook: 'N' }, { fieldId: 'f2', name: 'W', type: 'multiselect', value: ['p', 'q'], notebookId: 'nb', notebook: 'N' }] as LocalNote['fields'] }));
    const b = noteEntries(note('n10', { fields: [{ fieldId: 'f1', name: 'V', type: 'text', value: 'y', notebookId: 'nb', notebook: 'N' }] as LocalNote['fields'] }));
    await index.put('field', [...a.fields, ...b.fields]);
    expect([...(await index.stampsUnder('field', [fieldEntryPrefix('n1')])).keys()].sort()).toEqual(a.fields.map((f) => f.id).sort());
    // A multi-select is indexed as the server stores it, so each option is a word.
    expect((await index.candidates('field', '"q"*', -1)).map((c) => c.id)).toEqual([a.fields[1]!.id]);
  });

  it('keeps the last notes opened, and a newer index version starts empty', async () => {
    const db = await openTestSearchDb();
    const index = new SearchIndex(db);
    for (let i = 0; i < RECENT_NOTES + 5; i += 1) await index.markOpened(`n${i}`, i);
    await index.markOpened('n0', 1000);
    const opened = await index.opened();
    expect(opened).toHaveLength(RECENT_NOTES);
    expect(opened[0]).toBe('n0');
    expect(opened).not.toContain('n1');
    await index.put('tag', [{ id: 'x', stamp: '', columns: ['x'] }]);
    await index.clear();
    expect(await index.stamps('tag')).toEqual(new Map());
    expect(await index.opened()).toHaveLength(RECENT_NOTES);
    await db.execute(`UPDATE meta SET value = '0' WHERE key = 'version'`);
    expect(await new SearchIndex(db).opened()).toEqual([]);
  });
});

describe('textPlan', () => {
  const snapshot = {
    notes: [
      { id: 'kept', notebookId: 'nb-receipts' },
      { id: 'opened', notebookId: 'nb-manuals' },
      { id: 'far', notebookId: 'nb-manuals' },
      { id: 'binned', notebookId: 'nb-receipts', deletedAt: 4 },
    ],
    attachments: [
      { id: 'k-big', noteId: 'kept', size: 900, hasText: true },
      { id: 'k-small', noteId: 'kept', size: 10, hasText: true },
      { id: 'k-unread', noteId: 'kept', size: 5, hasText: false },
      { id: 'k-waiting', noteId: 'kept', size: 5, hasText: true, pending: true as const },
      { id: 'o1', noteId: 'opened', size: 500, hasText: true },
      { id: 'f1', noteId: 'far', size: 1, hasText: true },
      { id: 'b1', noteId: 'binned', size: 1, hasText: true },
    ],
  };

  const held = (entries: Record<string, number | { shed: number }>) =>
    new Map(Object.entries(entries).map(([id, v]) => [id, typeof v === 'number' ? { chars: v, shed: false } : { chars: v.shed, shed: true }]));

  it('wants the text of kept notebooks and opened notes, opened first, then the smallest', () => {
    expect(textPlan(snapshot, new Set(['nb-receipts']), ['opened'], held({}))).toEqual({ fetch: ['o1', 'k-small', 'k-big'], remove: [], shed: [] });
  });

  it('fetches only what is missing and drops what nothing wants any more', () => {
    expect(textPlan(snapshot, new Set(['nb-receipts']), [], held({ 'k-small': 40, o1: 9, b1: 9, 'deleted-file': 9 }))).toEqual({
      fetch: ['k-big'],
      remove: ['o1', 'b1', 'deleted-file'],
      shed: [],
    });
  });

  describe('the limit on opened notes', () => {
    const notes = ['newest', 'middle', 'oldest'].map((id) => ({ id, notebookId: 'nb-manuals' }));
    const files = [
      { id: 'n1', noteId: 'newest', size: 1, hasText: true },
      { id: 'm1', noteId: 'middle', size: 1, hasText: true },
      { id: 'o1', noteId: 'oldest', size: 1, hasText: true },
    ];
    const opened = ['newest', 'middle', 'oldest'];
    const plan = (have: Parameters<typeof held>[0], limit = 100, kept: string[] = []) => textPlan({ notes, attachments: files }, new Set(kept), opened, held(have), limit);

    it('lets go of the text of the first note that would pass it, and of every older one', () => {
      expect(plan({ n1: 60, m1: 50, o1: 10 })).toEqual({ fetch: [], remove: [], shed: [{ id: 'm1', chars: 50 }, { id: 'o1', chars: 10 }] });
    });

    it('remembers what it let go, so the next plan neither fetches it again nor lets it go twice', () => {
      expect(plan({ n1: 60, m1: { shed: 50 }, o1: { shed: 10 } })).toEqual({ fetch: [], remove: [], shed: [] });
    });

    it('fetches again what was let go once there is room for it', () => {
      expect(plan({ n1: 30, m1: { shed: 50 }, o1: { shed: 40 } })).toEqual({ fetch: ['m1'], remove: [], shed: [] });
    });

    it('does not fetch a file it has never held once the notes before it are over', () => {
      expect(plan({ n1: 60, m1: 50 })).toEqual({ fetch: [], remove: [], shed: [{ id: 'm1', chars: 50 }] });
    });

    it('holds the newest note whatever its size', () => {
      // It is kept, and it has used the room: nothing older is fetched to find out it does not fit.
      expect(plan({ n1: 500 })).toEqual({ fetch: [], remove: [], shed: [] });
      expect(plan({ n1: 500, m1: 5, o1: 5 })).toEqual({ fetch: [], remove: [], shed: [{ id: 'm1', chars: 5 }, { id: 'o1', chars: 5 }] });
    });

    it('does not count a kept notebook, whose size was agreed to when it was kept', () => {
      expect(plan({ n1: 60, m1: 50, o1: 10 }, 100, ['nb-manuals'])).toEqual({ fetch: [], remove: [], shed: [] });
    });
  });
});

describe('stampOf', () => {
  it('changes with the text and with where one part ends', () => {
    expect(stampOf('a', 'b')).toBe(stampOf('a', 'b'));
    expect(stampOf('ab', 'c')).not.toBe(stampOf('a', 'bc'));
    expect(stampOf('title', 'body')).not.toBe(stampOf('title', 'body.'));
  });
});

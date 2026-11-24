import { describe, expect, it } from 'vitest';
import { UNFILED, type Note, type SearchResult } from '@unbent/shared';
import { freshStore } from './helpers.js';
// The object's source, read as text, as feed-coverage.test.ts reads it.
import userStoreSource from '../../api/src/store/user-store.ts?raw';

/**
 * A connected assistant given some notebooks and not the whole library (MAK-264): what
 * `UserStore.scoped` lets it reach.
 *
 * Every call here goes through `scoped`, the way the Worker's restricted repos do, and
 * every expectation is about the other side of the grant: a note outside it must be
 * missing from each answer, not refused, and nothing an answer carries (a count, a tag's
 * name, a notebook's) may come from there.
 */

type Stub = ReturnType<typeof freshStore>['stub'];
interface Access {
  notebooks: string[];
  unfiled: boolean;
}

/** One restricted call. The answer is whatever the method of that name answers. */
function as<T>(stub: Stub, access: Access, method: string, ...args: unknown[]): Promise<T> {
  return stub.scoped(access, method, args) as Promise<T>;
}

/**
 * Two notebooks the grant will name, one it will not, and notes on every side: filed in
 * each, unfiled, and trashed inside and outside. `only-outside` is a tag no visible note
 * carries; `shared` is on both sides, twice inside and once outside.
 */
async function library(label: string) {
  const { stub } = freshStore(label);
  const letters = (await stub.createNotebook('Letters'))!;
  const recipes = (await stub.createNotebook('Recipes'))!;
  const ledger = (await stub.createNotebook('Ledger'))!;
  const make = (title: string, notebook: string | undefined, tags: string[], body = '') =>
    stub.create({ id: crypto.randomUUID(), title, body, tags, ...(notebook ? { notebook } : {}) });
  const letter = await make('A letter', 'Letters', ['shared'], 'the harbour at dusk');
  const recipe = await make('A recipe', 'Recipes', ['shared', 'kitchen'], 'the harbour chowder');
  const entry = await make('A ledger entry', 'Ledger', ['shared', 'only-outside'], 'the harbour dues');
  const loose = await make('A loose note', undefined, ['loose'], 'the harbour, unfiled');
  const binned = await make('A binned letter', 'Letters', [], 'thrown away');
  const binnedOutside = await make('A binned entry', 'Ledger', [], 'thrown away');
  await stub.remove(binned.id);
  await stub.remove(binnedOutside.id);
  const amount = (await stub.createField(ledger.id, { name: 'Amount', type: 'text', options: [] })) as { id: string };
  const sender = (await stub.createField(letters.id, { name: 'Sender', type: 'text', options: [] })) as { id: string };
  await stub.recordAttachment({ id: 'f-in', noteId: letter.id, filename: 'scan.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k/in' });
  await stub.recordAttachment({ id: 'f-out', noteId: entry.id, filename: 'scan.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k/out' });
  await stub.recordText({ attachmentId: 'f-out', noteId: entry.id, filename: 'scan.pdf', text: 'the harbour invoice' });
  return {
    stub,
    letters,
    recipes,
    ledger,
    letter,
    recipe,
    entry,
    loose,
    binned,
    binnedOutside,
    amount,
    sender,
    /** Letters and Recipes, and not the notes filed nowhere. */
    grant: { notebooks: [letters.id, recipes.id], unfiled: false } as Access,
  };
}

const titles = (rows: Array<{ title: string }>) => rows.map((r) => r.title).sort();

describe('a restricted connection reads only what it was given', () => {
  it('lists and counts the notes of its notebooks', async () => {
    const s = await library('access-list');
    const page = await as<{ items: Note[]; total: number }>(s.stub, s.grant, 'listPage', { limit: 50 }, {});
    expect(titles(page.items)).toEqual(['A letter', 'A recipe']);
    expect(page.total).toBe(2);

    // The count is asked for beside every first page, and a full page cannot answer it
    // from itself: the grant's size, from the stored counts.
    const full = await as<{ items: Note[]; total: number }>(s.stub, s.grant, 'listPage', { limit: 1 }, {});
    expect(full.items).toHaveLength(1);
    expect(full.total).toBe(2);
  });

  it('answers a filter naming a notebook outside the grant with nothing', async () => {
    const s = await library('access-filter');
    const outside = await as<{ items: Note[]; total: number }>(s.stub, s.grant, 'listPage', { limit: 50, notebook: 'Ledger' }, { notebook: 'Ledger' });
    expect(outside).toMatchObject({ items: [], total: 0 });
    // A full page's count is the stored one, which must not be the notebook's own.
    const counted = await as<{ items: Note[]; total: number }>(s.stub, s.grant, 'listPage', { limit: 0 }, { notebook: 'Ledger' });
    expect(counted.total).toBe(0);

    const inside = await as<{ items: Note[]; total: number }>(s.stub, s.grant, 'listPage', { limit: 50, notebook: 'Letters' }, { notebook: 'Letters' });
    expect(titles(inside.items)).toEqual(['A letter']);
  });

  it('sees unfiled notes only when the grant says so', async () => {
    const s = await library('access-unfiled');
    const without = await as<{ items: Note[]; total: number }>(s.stub, s.grant, 'listPage', { limit: 50, notebook: UNFILED }, { notebook: UNFILED });
    expect(without).toMatchObject({ items: [], total: 0 });

    const withUnfiled = { ...s.grant, unfiled: true };
    const page = await as<{ items: Note[]; total: number }>(s.stub, withUnfiled, 'listPage', { limit: 50 }, {});
    expect(titles(page.items)).toEqual(['A letter', 'A loose note', 'A recipe']);
    expect(page.total).toBe(3);

    // Nothing but the unfiled: a grant may name no notebook at all.
    const only = await as<{ items: Note[]; total: number }>(s.stub, { notebooks: [], unfiled: true }, 'listPage', { limit: 50 }, {});
    expect(titles(only.items)).toEqual(['A loose note']);
  });

  it('gives a grant of nothing nothing', async () => {
    const s = await library('access-empty');
    const nothing = { notebooks: [], unfiled: false };
    expect(await as(s.stub, nothing, 'listPage', { limit: 50 }, {})).toMatchObject({ items: [], total: 0 });
    expect(await as(s.stub, nothing, 'search', 'harbour', 50)).toEqual([]);
    expect(await as(s.stub, nothing, 'listTags')).toEqual([]);
    expect(await as(s.stub, nothing, 'get', s.letter.id)).toBeNull();
  });

  it('keeps a tag beside the grant, and the trash under it', async () => {
    const s = await library('access-tag');
    const tagged = await as<{ items: Note[]; total: number }>(s.stub, s.grant, 'listPage', { limit: 50, tags: ['shared'] }, { tags: ['shared'] });
    expect(titles(tagged.items)).toEqual(['A letter', 'A recipe']);
    expect(tagged.total).toBe(2);

    const trash = await as<{ items: Note[]; total: number }>(s.stub, s.grant, 'listPage', { limit: 50, trashed: true }, { trashed: true });
    expect(titles(trash.items)).toEqual(['A binned letter']);
    expect(trash.total).toBe(1);
  });

  it('searches its own notes, in both of the search\'s shapes', async () => {
    const s = await library('access-search');
    // The grant is small, so the search is asked of its notes one by one.
    const small = await as<SearchResult[]>(s.stub, s.grant, 'search', 'harbour', 50);
    expect(titles(small)).toEqual(['A letter', 'A recipe']);
    // With the threshold at nothing, the full-text index leads and each match is tested
    // against the grant: the shape an archive-sized grant takes.
    const large = await as<SearchResult[]>(s.stub, s.grant, 'search', 'harbour', 50, {}, 0);
    expect(titles(large)).toEqual(['A letter', 'A recipe']);
    // A file's text outside the grant finds nothing, whichever shape reads it.
    expect(await as(s.stub, s.grant, 'search', 'invoice', 50)).toEqual([]);
    expect(await as(s.stub, s.grant, 'search', 'invoice', 50, {}, 0)).toEqual([]);

    const withFiles = await as<{ results: SearchResult[]; summaries: Record<string, unknown> }>(s.stub, s.grant, 'searchWithFiles', 'harbour', 50);
    expect(titles(withFiles.results)).toEqual(['A letter', 'A recipe']);
    expect(Object.keys(withFiles.summaries)).not.toContain(s.entry.id);
  });

  it('answers a note outside the grant as a note that does not exist', async () => {
    const s = await library('access-get');
    expect(await as<Note | null>(s.stub, s.grant, 'get', s.letter.id)).toMatchObject({ title: 'A letter' });
    for (const id of [s.entry.id, s.loose.id, s.binnedOutside.id, crypto.randomUUID()]) {
      expect(await as(s.stub, s.grant, 'get', id, { includeTrashed: true })).toBeNull();
      expect(await as(s.stub, s.grant, 'getWithFiles', id)).toBeNull();
      expect(await as(s.stub, s.grant, 'linkedFilenames', id)).toBeNull();
    }
    // The trash follows the note's notebook: a binned letter is still a letter.
    expect(await as<Note | null>(s.stub, s.grant, 'get', s.binned.id, { includeTrashed: true })).toMatchObject({ title: 'A binned letter' });
  });

  it('reaches a file only through a note it can see', async () => {
    const s = await library('access-files');
    expect(await as(s.stub, s.grant, 'resolveAttachment', s.letter.id, 'scan.pdf')).toMatchObject({ id: 'f-in' });
    expect(await as(s.stub, s.grant, 'resolveAttachment', s.entry.id, 'scan.pdf')).toBeNull();
    expect(await as(s.stub, s.grant, 'resolveWithRead', s.entry.id, 'scan.pdf', false)).toBeNull();
    expect(await as(s.stub, s.grant, 'textWithRead', s.entry.id, 'scan.pdf', false)).toBeNull();
    expect(await as(s.stub, s.grant, 'listAttachments', s.entry.id)).toEqual([]);
    expect(await as(s.stub, s.grant, 'ownsNote', s.entry.id)).toBe(false);
    expect(await as(s.stub, s.grant, 'ownsNote', s.letter.id)).toBe(true);
  });

  it('lists its notebooks and their fields, and no other', async () => {
    const s = await library('access-notebooks');
    const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name).sort();
    expect(names(await as(s.stub, s.grant, 'listNotebooks'))).toEqual(['Letters', 'Recipes']);

    const overview = await as<{ notebooks: Array<{ name: string }>; unfiled: number; fields: Array<{ name: string }> }>(s.stub, s.grant, 'notebooksOverview', { fields: true });
    expect(names(overview.notebooks)).toEqual(['Letters', 'Recipes']);
    expect(overview.unfiled).toBe(0);
    expect(names(overview.fields)).toEqual(['Sender']);
    expect((await as<{ unfiled: number }>(s.stub, { ...s.grant, unfiled: true }, 'notebooksOverview')).unfiled).toBe(1);

    expect(await as(s.stub, s.grant, 'notebookByName', 'letters')).toMatchObject({ id: s.letters.id });
    expect(await as(s.stub, s.grant, 'notebookByName', 'Ledger')).toBeNull();
    expect(await as(s.stub, s.grant, 'listFields', s.letters.id)).toHaveLength(1);
    expect(await as(s.stub, s.grant, 'listFields', s.ledger.id)).toBeNull();

    // Where a set of notes is filed: the ones it cannot see are not in the set.
    const targets = await as<{ matched: string[]; notebooks: Array<{ name: string | null }> }>(s.stub, s.grant, 'fieldTargets', [s.letter.id, s.entry.id, s.loose.id]);
    expect(targets.matched).toEqual([s.letter.id]);
    expect(targets.notebooks.map((n) => n.name)).toEqual(['Letters']);
  });

  it('names and counts tags from the notes it can see', async () => {
    const s = await library('access-tags');
    const tags = await as<Array<{ name: string; count: number; color: number | null }>>(s.stub, s.grant, 'listTags');
    expect(tags.map((t) => [t.name, t.count])).toEqual([['shared', 2], ['kitchen', 1]]);
    // The colour comes with it, as the unrestricted list's does.
    expect(tags.every((t) => 'color' in t)).toBe(true);
    // The account's own list has the rest, so this is the grant's doing.
    expect((await s.stub.listTags()).map((t) => t.name).sort()).toEqual(['kitchen', 'loose', 'only-outside', 'shared']);

    expect(await as(s.stub, s.grant, 'tagCounts', { tags: ['shared'] })).toMatchObject([{ name: 'kitchen', count: 1 }]);
    expect(await as(s.stub, s.grant, 'tagCounts', { notebook: 'Ledger' })).toEqual([]);
  });

  it('holds a grant of one notebook to that notebook', async () => {
    const s = await library('access-one');
    const one = { notebooks: [s.recipes.id], unfiled: false };
    const page = await as<{ items: Note[]; total: number }>(s.stub, one, 'listPage', { limit: 50 }, {});
    expect(titles(page.items)).toEqual(['A recipe']);
    expect(page.total).toBe(1);
    expect(titles(await as<SearchResult[]>(s.stub, one, 'search', 'harbour', 50))).toEqual(['A recipe']);
  });

  it('ignores an id that names no notebook', async () => {
    const s = await library('access-dead');
    const stale = { notebooks: [s.letters.id, crypto.randomUUID()], unfiled: false };
    expect(titles((await as<{ items: Note[] }>(s.stub, stale, 'listPage', { limit: 50 }, {})).items)).toEqual(['A letter']);
  });
});

describe('a restricted connection writes only where it was given', () => {
  const refused = (reason: string) => ({ code: 'ACCESS_REFUSED', reason });
  const input = (over: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), title: 'New', body: '', tags: [], ...over });

  it('files a new note in a notebook of its grant, and nowhere else', async () => {
    const s = await library('access-create');
    const made = await as<Note>(s.stub, s.grant, 'create', input({ notebook: 'letters' }));
    // Matched without case, like any filing; the note is in the notebook as it is named.
    expect(await s.stub.get(made.id)).toMatchObject({ title: 'New', notebook: 'Letters' });

    await expect(as(s.stub, s.grant, 'create', input({ notebook: 'Ledger' }))).rejects.toMatchObject(refused('notebook'));
    // A name nobody has used would make a notebook, which is how they are made: refused
    // the same way, so the refusal does not say which names exist.
    await expect(as(s.stub, s.grant, 'create', input({ notebook: 'Brand new' }))).rejects.toMatchObject(refused('notebook'));
    await expect(as(s.stub, s.grant, 'create', input())).rejects.toMatchObject(refused('unfiled'));
    await expect(as(s.stub, s.grant, 'createOrFind', input({ notebook: 'Ledger' }))).rejects.toMatchObject(refused('notebook'));
    // All or none: one note bound for outside the grant stops the batch.
    await expect(as(s.stub, s.grant, 'createMany', [input({ notebook: 'Recipes' }), input({ notebook: 'Ledger' })])).rejects.toMatchObject(refused('notebook'));

    expect((await s.stub.listNotebooks()).map((n) => n.name).sort()).toEqual(['Ledger', 'Letters', 'Recipes']);
    expect(await s.stub.count()).toBe(5);

    // With the unfiled in the grant, a note may be left in no notebook.
    const loose = await as<Note>(s.stub, { ...s.grant, unfiled: true }, 'create', input());
    expect(loose.notebook).toBeNull();
  });

  it('will not answer a create with a note it cannot see', async () => {
    const s = await library('access-replay');
    // The replay-safe create answers with the holder of a taken id.
    await expect(as(s.stub, s.grant, 'createOrFind', input({ id: s.entry.id, notebook: 'Letters' }))).rejects.toMatchObject(refused('method'));
    await expect(as(s.stub, s.grant, 'createMany', [input({ id: s.entry.id, notebook: 'Letters' })], { skipExisting: true })).rejects.toMatchObject(refused('method'));
    // Its own note's id is a replay like anyone's.
    const again = await as<{ note: Note; existing: boolean }>(s.stub, s.grant, 'createOrFind', input({ id: s.letter.id, notebook: 'Letters' }));
    expect(again).toMatchObject({ existing: true, note: { title: 'A letter' } });
  });

  it('changes, trashes and restores only notes it can see', async () => {
    const s = await library('access-update');
    expect(await as<Note>(s.stub, s.grant, 'update', s.letter.id, { title: 'A letter, edited' })).toMatchObject({ title: 'A letter, edited' });
    expect(await as(s.stub, s.grant, 'update', s.entry.id, { title: 'Reached' })).toBeNull();
    expect(await as(s.stub, s.grant, 'appendToBody', s.entry.id, 'more')).toBe(false);
    expect(await as(s.stub, s.grant, 'remove', s.entry.id)).toBe(false);
    expect(await as(s.stub, s.grant, 'restore', s.binnedOutside.id)).toBe(false);
    expect(await s.stub.get(s.entry.id)).toMatchObject({ title: 'A ledger entry', body: 'the harbour dues' });
    expect(await s.stub.get(s.binnedOutside.id)).toBeNull();

    expect(await as(s.stub, s.grant, 'remove', s.recipe.id)).toBe(true);
    expect(await as(s.stub, s.grant, 'restore', s.recipe.id)).toBe(true);
    expect(await as(s.stub, s.grant, 'restore', s.binned.id)).toBe(true);
  });

  it('moves a note between its notebooks, and not out of them', async () => {
    const s = await library('access-move');
    expect(await as<Note>(s.stub, s.grant, 'update', s.letter.id, { notebook: 'Recipes' })).toMatchObject({ notebook: 'Recipes' });
    await expect(as(s.stub, s.grant, 'update', s.letter.id, { notebook: 'Ledger' })).rejects.toMatchObject(refused('notebook'));
    await expect(as(s.stub, s.grant, 'update', s.letter.id, { notebook: null })).rejects.toMatchObject(refused('unfiled'));
    await expect(as(s.stub, s.grant, 'updateMany', [s.letter.id, s.recipe.id], { notebook: 'Ledger' })).rejects.toMatchObject(refused('notebook'));
    expect((await s.stub.get(s.letter.id))!.notebook).toBe('Recipes');
    expect((await s.stub.get(s.recipe.id))!.notebook).toBe('Recipes');
  });

  it('leaves the notes it cannot see out of a bulk write', async () => {
    const s = await library('access-bulk');
    const all = [s.letter.id, s.entry.id, s.loose.id];
    const tagged = await as<{ matched: string[]; changed: string[] }>(s.stub, s.grant, 'updateMany', all, { addTags: ['swept'] });
    expect(tagged).toEqual({ matched: [s.letter.id], changed: [s.letter.id] });
    expect((await s.stub.get(s.entry.id))!.tags).not.toContain('swept');

    expect(await as(s.stub, s.grant, 'removeMany', all)).toEqual([s.letter.id]);
    expect(await s.stub.get(s.entry.id)).not.toBeNull();
    expect(await s.stub.get(s.loose.id)).not.toBeNull();
    expect(await as(s.stub, s.grant, 'restoreMany', [s.letter.id, s.binnedOutside.id])).toEqual([s.letter.id]);
  });

  it('manages a notebook of its grant, and finds no other', async () => {
    const s = await library('access-manage');
    expect(await as(s.stub, s.grant, 'updateNotebook', s.letters.id, { purpose: 'Post, in and out' })).toBe('ok');
    expect(await as(s.stub, s.grant, 'updateNotebook', s.ledger.id, { purpose: 'Reached' })).toBe('missing');
    expect(await as(s.stub, s.grant, 'createField', s.letters.id, { name: 'Postmark', type: 'text', options: [] })).toMatchObject({ name: 'Postmark' });
    expect(await as(s.stub, s.grant, 'createField', s.ledger.id, { name: 'Reached', type: 'text', options: [] })).toBe('missing');
    expect(await as(s.stub, s.grant, 'updateField', s.ledger.id, s.amount.id, { name: 'Reached' })).toBe('missing');
    expect(await as(s.stub, s.grant, 'editFieldOptions', s.ledger.id, s.amount.id, { add: ['x'] })).toBe('missing');
    expect((await s.stub.listFields(s.ledger.id))!.map((f) => f.name)).toEqual(['Amount']);
    expect((await s.stub.listNotebooks()).find((n) => n.id === s.ledger.id)!.purpose ?? null).toBeNull();
  });

  it('refuses what reaches past any one notebook', async () => {
    const s = await library('access-past');
    const shared = (await s.stub.listTags()).find((t) => t.name === 'shared')!;
    await expect(as(s.stub, s.grant, 'createNotebook', 'Another')).rejects.toMatchObject(refused('manage'));
    // Its own notebook too: deleting it unfiles or trashes notes, and its views go with it.
    await expect(as(s.stub, s.grant, 'deleteNotebook', s.letters.id)).rejects.toMatchObject(refused('manage'));
    await expect(as(s.stub, s.grant, 'renameTag', shared.id, 'renamed')).rejects.toMatchObject(refused('manage'));
    await expect(as(s.stub, s.grant, 'deleteTag', shared.id)).rejects.toMatchObject(refused('manage'));
    expect((await s.stub.listNotebooks()).map((n) => n.name).sort()).toEqual(['Ledger', 'Letters', 'Recipes']);
    expect((await s.stub.listTags()).map((t) => t.name)).toContain('shared');
  });

  it('adds a file, and writes what a picture says, only on a note it can see', async () => {
    const s = await library('access-file-writes');
    const file = (id: string, noteId: string) => ({ id, noteId, filename: 'card.jpg', contentType: 'image/jpeg', size: 3, r2Key: `k/${id}` });
    expect(await as(s.stub, s.grant, 'availableFilename', s.letter.id, 'scan.pdf')).toBe('scan-2.pdf');
    expect(await as(s.stub, s.grant, 'recordAttachment', file('f-new', s.letter.id))).toMatchObject({ filename: 'card.jpg' });
    expect(await as(s.stub, s.grant, 'writeAssistantText', s.letter.id, 'card.jpg', 'a business card')).toMatchObject({ ok: true });

    await expect(as(s.stub, s.grant, 'availableFilename', s.entry.id, 'scan.pdf')).rejects.toMatchObject(refused('method'));
    await expect(as(s.stub, s.grant, 'recordAttachment', file('f-reach', s.entry.id))).rejects.toMatchObject(refused('method'));
    expect(await as(s.stub, s.grant, 'writeAssistantText', s.entry.id, 'scan.pdf', 'reached')).toMatchObject({ ok: false, reason: 'missing' });
    expect((await s.stub.listAttachments(s.entry.id)).map((f) => f.filename)).toEqual(['scan.pdf']);
  });

  it('records a write in the feed as the same write by anyone does', async () => {
    const s = await library('access-feed');
    const before = (await s.stub.changesSince(0, 500) as { seq: number }).seq;
    await as(s.stub, s.grant, 'update', s.letter.id, { title: 'Recorded' });
    const page = await s.stub.changesSince(before, 500) as { notes: Array<{ id: string }> };
    expect(page.notes.map((n) => n.id)).toEqual([s.letter.id]);
  });
});

describe('a restricted connection reaches the store only through the list', () => {
  it('refuses a method nobody has decided about, by name', async () => {
    const s = await library('access-unlisted');
    // Real methods of the object, each of which would read or write past a grant.
    for (const method of ['exportPage', 'purge', 'readOnlySql', 'snapshotPage', 'wipe', 'listFull', 'scoped']) {
      await expect(as(s.stub, s.grant, method), method).rejects.toMatchObject({ code: 'ACCESS_REFUSED', reason: 'method' });
    }
    // And what is not a method at all, including what every object inherits.
    for (const method of ['constructor', 'toString', '__proto__', 'restricted', 'nope']) {
      await expect(as(s.stub, s.grant, method), method).rejects.toMatchObject({ code: 'ACCESS_REFUSED', reason: 'method' });
    }
  });

  it('refuses a grant that is not one', async () => {
    const s = await library('access-shape');
    for (const bad of [null, {}, { notebooks: 'all', unfiled: false }, { notebooks: [1], unfiled: false }, { notebooks: [] }]) {
      await expect(s.stub.scoped(bad as never, 'listNotebooks', [])).rejects.toThrow(/needs its grant/);
    }
  });

  it('leaves no grant in force for the call after it', async () => {
    const s = await library('access-after');
    await as(s.stub, s.grant, 'listPage', { limit: 50 }, {});
    // A refusal is the path that would leave it behind.
    await expect(as(s.stub, s.grant, 'wipe')).rejects.toMatchObject({ reason: 'method' });
    expect(await s.stub.count()).toBe(4);
    expect((await s.stub.listNotebooks()).map((n) => n.name).sort()).toEqual(['Ledger', 'Letters', 'Recipes']);
  });

  /**
   * The list is closed: an entry is a decision someone made about that method and a
   * grant, and this is where a new one is read. Adding a method to `restricted` without
   * a line here fails by name, as a method added to the object fails feed-coverage.
   */
  it('lists exactly the methods this file has looked at', () => {
    const block = /private readonly restricted[^=]*= \{\n([\s\S]*?)\n  \};/.exec(userStoreSource)?.[1] ?? '';
    const entries = [...block.matchAll(/^    ([a-zA-Z]\w*): /gm)].map((m) => m[1]!);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.sort()).toEqual([...HELD].sort());
  });
});

/** Every method a restricted connection may call, or is refused by name for asking. Each is exercised above. */
const HELD = [
  'get', 'getWithFiles', 'linkedFilenames', 'fieldTargets',
  'listPage', 'search', 'searchWithFiles',
  'listNotebooks', 'notebooksOverview', 'notebookByName', 'listFields',
  'listTags', 'tagCounts',
  'resolveAttachment', 'resolveWithRead', 'textWithRead', 'listAttachments', 'ownsNote',
  'attachmentBytes', 'usage',
  'create', 'createOrFind', 'createMany',
  'update', 'appendToBody', 'remove', 'restore', 'updateMany', 'removeMany', 'restoreMany',
  'updateNotebook', 'createField', 'updateField', 'editFieldOptions',
  'createNotebook', 'deleteNotebook', 'renameTag', 'deleteTag',
  'availableFilename', 'recordAttachment', 'writeAssistantText',
];

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AttachmentTexts, FeedAttachment } from '@unbent/shared';
import { SearchIndex } from './search-index.js';
import { BUILT, searchLocal } from './search-local.js';
import { createSearchSync, type SearchSyncOptions } from './search-sync.js';
import { openTestSearchDb } from './test-search-db.js';
import type { LocalNote, Snapshot } from './derive.js';

const note = (id: string, over: Partial<LocalNote> = {}): LocalNote =>
  ({ id, title: '', body: '', tagIds: [], files: [], fields: [], notebookId: null, createdAt: 1, updatedAt: 1, ...over }) as LocalNote;
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

class Offline extends Error {}

/** A library a test can change, and a sync over it with every seam in the test's hands. */
async function setup() {
  const index = new SearchIndex(await openTestSearchDb());
  const lib = { notes: [] as LocalNote[], attachments: [] as FeedAttachment[], tags: [{ id: 't1', name: 'garden' }] };
  const world = { settled: true, leading: true, offline: false, kept: ['nb-kept'] as string[] | Error, texts: {} as Record<string, string>, asked: [] as string[][] };
  const snapshot = (): Snapshot => ({ notes: lib.notes, notebooks: [], tags: lib.tags, attachments: lib.attachments });
  const make = (over: Partial<SearchSyncOptions> = {}) =>
    createSearchSync({
      index,
      snapshot,
      settled: () => world.settled,
      leading: () => world.leading,
      offline: () => world.offline,
      kept: async () => {
        if (world.kept instanceof Error) throw world.kept;
        return world.kept;
      },
      fetchTexts: async (ids): Promise<AttachmentTexts> => {
        if (world.offline) throw new Offline();
        world.asked.push(ids);
        return { texts: ids.filter((id) => id in world.texts).map((id) => ({ id, text: world.texts[id]! })), left: [] };
      },
      isOffline: (err) => err instanceof Offline,
      ...over,
    });
  const found = async (query: string) => (await searchLocal({ index, snapshot: snapshot(), query })).results.map((r) => r.id);
  return { index, lib, world, make, found };
}

describe('SearchSync', () => {
  it('indexes a whole library on its first pass, then only what is touched', async () => {
    const { index, lib, make, found } = await setup();
    lib.notes = [note('a', { title: 'Apple pie' }), note('b', { title: 'Bread', tagIds: ['t1'] }), note('gone', { title: 'Apple crumble', deletedAt: 5 })];
    const sync = make();
    await sync.idle();
    expect(await found('apple')).toEqual(['a']);
    expect(await found('garden')).toEqual(['b']);
    expect(await index.meta(BUILT)).toBe('1');

    // An edit, a trashing and a new note, named by the library.
    lib.notes = [note('a', { title: 'Apple tart' }), note('b', { title: 'Bread', tagIds: ['t1'], deletedAt: 9 }), note('c', { title: 'Cider' })];
    sync.touch(['a', 'b', 'c']);
    await sync.idle();
    expect(await found('pie')).toEqual([]);
    expect(await found('tart')).toEqual(['a']);
    expect(await found('cider')).toEqual(['c']);
    expect([...(await index.stamps('note')).keys()].sort()).toEqual(['a', 'c']);

    // A change nobody named is not looked for: that is what makes a pass cheap.
    lib.notes = [...lib.notes, note('unnamed', { title: 'Damson jam' })];
    sync.touch(['a']);
    await sync.idle();
    expect(await found('damson')).toEqual([]);
    sync.touch(null);
    await sync.idle();
    expect(await found('damson')).toEqual(['unnamed']);
    sync.stop();
  });

  it('writes nothing for a note that is indexed as it stands', async () => {
    const { index, lib, make } = await setup();
    lib.notes = [note('a', { title: 'Same', body: 'text' })];
    const sync = make();
    await sync.idle();
    const [before] = await (index as unknown as { db: { execute: (sql: string) => Promise<Array<{ rowid: number }>> } }).db.execute(`SELECT rowid FROM entries WHERE kind = 'note'`);
    sync.touch(null);
    await sync.idle();
    const [after] = await (index as unknown as { db: { execute: (sql: string) => Promise<Array<{ rowid: number }>> } }).db.execute(`SELECT rowid FROM entries WHERE kind = 'note'`);
    expect(after).toEqual(before);
    sync.stop();
  });

  it('stands down while the library is not whole or the tab does not lead, and drops nothing', async () => {
    const { lib, world, make, found } = await setup();
    lib.notes = [note('a', { title: 'Ledger' })];
    const sync = make();
    await sync.idle();
    // A reset empties the collections before the walk refills them.
    world.settled = false;
    lib.notes = [];
    sync.touch(['a']);
    await sync.idle();
    lib.notes = [note('a', { title: 'Ledger' })];
    expect(await found('ledger')).toEqual(['a']);
    world.settled = true;
    world.leading = false;
    lib.notes = [note('a', { title: 'Ledger' }), note('b', { title: 'Ledger two' })];
    sync.touch(['b']);
    await sync.idle();
    expect(await found('ledger')).toEqual(['a']);
    world.leading = true;
    sync.touchFiles();
    await sync.idle();
    expect((await found('ledger')).sort()).toEqual(['a', 'b']);
    sync.stop();
  });

  it('fetches the text of kept notebooks and opened notes, and drops it when neither wants it', async () => {
    const { index, lib, world, make, found } = await setup();
    lib.notes = [note('kept', { notebookId: 'nb-kept' }), note('far', { notebookId: 'nb-far' })];
    lib.attachments = [file('k1', 'kept'), file('k-empty', 'kept'), file('f1', 'far')];
    world.texts = { k1: 'warranty for the dishwasher', f1: 'manual for the lathe' };
    const sync = make();
    await sync.idle();
    expect(await found('dishwasher')).toEqual(['kept']);
    expect(await found('lathe')).toEqual([]);
    // A file with no text on the server is not asked for twice.
    expect(world.asked).toEqual([['k1', 'k-empty']]);
    sync.touchFiles();
    await sync.idle();
    expect(world.asked).toHaveLength(1);

    await sync.opened('far');
    await sync.idle();
    expect(await found('lathe')).toEqual(['far']);

    world.kept = [];
    sync.touchFiles();
    await sync.idle();
    expect(await found('dishwasher')).toEqual([]);
    expect([...(await index.stamps('file')).keys()]).toEqual(['f1']);
    sync.stop();
  });

  it('asks again for what an answer had no room for', async () => {
    const { lib, make, found } = await setup();
    lib.notes = [note('kept', { notebookId: 'nb-kept' })];
    lib.attachments = [file('k1', 'kept', { size: 1 }), file('k2', 'kept', { size: 2 })];
    const asked: string[][] = [];
    const sync = make({
      fetchTexts: async (ids) => {
        asked.push(ids);
        return { texts: [{ id: ids[0]!, text: `text of ${ids[0]}` }], left: ids.slice(1) };
      },
    });
    await sync.idle();
    expect(asked).toEqual([['k1', 'k2'], ['k2']]);
    expect(await found('k2')).toEqual(['kept']);
    sync.stop();
  });

  it('empties the index when the library starts over, so a file’s text is fetched again', async () => {
    const { index, lib, world, make, found } = await setup();
    lib.notes = [note('kept', { notebookId: 'nb-kept', title: 'Policy' })];
    lib.attachments = [file('k1', 'kept')];
    world.texts = { k1: 'the old schedule of cover' };
    const sync = make();
    await sync.idle();
    await index.markOpened('kept');
    // A restore on the server: the same file id, different text. The feed says reset,
    // the collections empty, and the walk brings the rows back.
    world.texts = { k1: 'the restored schedule of cover' };
    world.settled = false;
    sync.startOver();
    await sync.idle();
    expect(await index.meta(BUILT)).toBe('1');
    world.settled = true;
    sync.wake();
    await sync.idle();
    expect(await found('restored')).toEqual(['kept']);
    expect(await found('old')).toEqual([]);
    expect(await found('policy')).toEqual(['kept']);
    // What was opened here is the device's, not the library's, and stays.
    expect(await index.opened()).toEqual(['kept']);
    sync.stop();
  });

  it('stops at once with a request for text in flight, by ending the request', async () => {
    const { lib, make } = await setup();
    lib.notes = [note('kept', { notebookId: 'nb-kept' })];
    lib.attachments = [file('k1', 'kept')];
    let asked = false;
    const sync = make({
      // A connection that has stalled: no answer, until the caller gives up.
      fetchTexts: (_ids, signal) =>
        new Promise((_resolve, reject) => {
          asked = true;
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    while (!asked) await new Promise((r) => setTimeout(r, 5));
    await sync.stop();
  });

  it('waits for a connection, and removes nothing when the kept list cannot be read', async () => {
    const { index, lib, world, make, found } = await setup();
    lib.notes = [note('kept', { notebookId: 'nb-kept' })];
    lib.attachments = [file('k1', 'kept')];
    world.texts = { k1: 'boarding pass' };
    world.offline = true;
    const sync = make();
    await sync.idle();
    expect(await found('boarding')).toEqual([]);
    world.offline = false;
    sync.touchFiles();
    await sync.idle();
    expect(await found('boarding')).toEqual(['kept']);

    world.kept = new Error('unreadable');
    sync.touchFiles();
    await sync.idle();
    expect([...(await index.stamps('file')).keys()]).toEqual(['k1']);
    sync.stop();
  });
});

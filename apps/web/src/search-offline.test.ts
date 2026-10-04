import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedAttachment, FeedNote } from '@unbent/shared';
import * as api from './notes-api.js';
import { resetConnectivity, setReachableForTests } from './connectivity.js';
import { searchQuery } from './queries.js';
import { SearchIndex } from './store/search-index.js';
import { createSearchSync } from './store/search-sync.js';
import { installTestLibrary, type TestLibrary } from './store/test-library.js';
import { openTestSearchDb } from './store/test-search-db.js';

vi.mock('./notes-api.js', async (original) => ({ ...(await original<typeof api>()), searchNotes: vi.fn() }));

/**
 * The search box's one query, with and without a connection: the server's answer when it
 * can be reached, the device's index when it cannot, under the same key.
 */
const note = (id: string, over: Partial<FeedNote> = {}): FeedNote =>
  ({ id, title: '', body: '', tagIds: [], files: [], fields: [], notebookId: null, createdAt: 1, updatedAt: 1, ...over }) as FeedNote;
const scan: FeedAttachment = { id: 'x1', noteId: 'far', filename: 'scan.pdf', contentType: 'application/pdf', size: 9, hasText: true, createdAt: 1 };

let lib: TestLibrary;

/** A test library with an index over it, built as a pass builds it. */
async function library(notes: FeedNote[], attachments: FeedAttachment[] = []) {
  lib = installTestLibrary({ notes, attachments });
  const index = new SearchIndex(await openTestSearchDb());
  const sync = createSearchSync({
    index,
    snapshot: () => ({ notes: lib.notes.values(), notebooks: lib.notebooks.values(), tags: lib.tags.values(), attachments: lib.attachments.values() }),
    settled: () => true,
    leading: () => true,
    kept: async () => [],
    offline: () => true,
    fetchTexts: async () => ({ texts: [], left: [] }),
    isOffline: () => false,
  });
  await sync.idle();
  (lib as { search?: unknown }).search = { index, sync };
}

beforeEach(() => {
  resetConnectivity();
  vi.mocked(api.searchNotes).mockReset();
});

afterEach(() => {
  lib?.uninstall();
  resetConnectivity();
});

describe('searchQuery', () => {
  it('asks the server while there is a connection, and says nothing about coverage', async () => {
    await library([note('a', { title: 'Passport renewal' })]);
    vi.mocked(api.searchNotes).mockResolvedValue([{ id: 'server', title: 'From the server', updatedAt: 1, snippet: '' }]);
    const answer = await new QueryClient().fetchQuery(searchQuery('passport'));
    expect(answer).toEqual({ results: [{ id: 'server', title: 'From the server', updatedAt: 1, snippet: '' }] });
  });

  it('answers from the device when offline, and counts the files it could not search', async () => {
    await library([note('a', { title: 'Passport renewal', body: 'Photos and the old passport.' }), note('far')], [scan]);
    setReachableForTests(false);
    const answer = await new QueryClient().fetchQuery(searchQuery('passport'));
    expect(api.searchNotes).not.toHaveBeenCalled();
    expect(answer.results.map((r) => r.id)).toEqual(['a']);
    expect(answer.local).toEqual({ built: true, files: { searched: 0, total: 1 } });
  });

  it('answers from the device when the request finds no connection, before the app has noticed', async () => {
    await library([note('a', { title: 'Passport renewal' })]);
    vi.mocked(api.searchNotes).mockRejectedValue(new api.OfflineError());
    const answer = await new QueryClient().fetchQuery(searchQuery('passport'));
    expect(answer.results.map((r) => r.id)).toEqual(['a']);
    expect(answer.local?.built).toBe(true);
  });

  it('fails as offline on a device with no index, and passes on any other failure', async () => {
    lib = installTestLibrary({ notes: [note('a', { title: 'Passport renewal' })] });
    setReachableForTests(false);
    await expect(new QueryClient().fetchQuery({ ...searchQuery('passport'), retry: false })).rejects.toBeInstanceOf(api.OfflineError);
    setReachableForTests(true);
    vi.mocked(api.searchNotes).mockRejectedValue(new api.ApiError(500, 'broken'));
    await expect(new QueryClient().fetchQuery({ ...searchQuery('passport'), retry: false })).rejects.toMatchObject({ status: 500 });
  });
});

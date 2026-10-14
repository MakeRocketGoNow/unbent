import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedNote } from '@unbent/shared';
import { installTestLibrary } from './test-library.js';
import { LIBRARY_ROOTS, onLibraryChange } from './library.js';

/**
 * The test library tells the query bridge what the real one tells it, so a component
 * test that removes a seeded row sees the same re-run a feed tombstone causes in the app.
 */
describe('installTestLibrary', () => {
  const note: FeedNote = { id: 'n1', title: 'a', body: 'b', createdAt: 1, updatedAt: 1, deletedAt: undefined, notebookId: undefined, tagIds: [], fields: [], files: [] } as unknown as FeedNote;
  let uninstall = () => {};
  afterEach(() => uninstall());

  it('tells the query bridge when a seeded row is removed', () => {
    const lib = installTestLibrary({ notes: [note] });
    uninstall = lib.uninstall;
    const heard = vi.fn();
    const stop = onLibraryChange(heard);
    lib.remove('note', note.id);
    stop();
    expect(heard).toHaveBeenCalledWith(LIBRARY_ROOTS);
    expect(lib.notes.has(note.id)).toBe(false);
  });

  it('reaches only the list and the note for a change of a seeded row’s text', () => {
    const lib = installTestLibrary({ notes: [note] });
    uninstall = lib.uninstall;
    const heard = vi.fn();
    const stop = onLibraryChange(heard);
    lib.upsert('note', { ...note, body: 'c', updatedAt: 2 });
    stop();
    expect(heard).toHaveBeenCalledTimes(1);
    expect([...(heard.mock.calls[0]![0] as Set<string>)].sort()).toEqual(['note', 'notes']);
  });
});

import { useEffect } from 'react';
import { usePersistentState } from './usePersistentState.js';
import type { NotesViewMode } from './useNotesLayout.js';

/**
 * Reads the stored view. It was briefly a map of notebook id to `'table'`; a browser still
 * holding that shape chose the table somewhere, so it reads as the table rather than as
 * nothing.
 */
function parseView(raw: unknown): NotesViewMode | undefined {
  if (raw === 'list' || raw === 'cards' || raw === 'table') return raw;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return Object.values(raw).includes('table') ? 'table' : 'list';
  }
  return undefined;
}

/**
 * How the note list is drawn: the sidebar of entries, the gallery of cards, or the table
 * of a notebook's fields.
 *
 * The URL's `view` is the answer whenever it is there, and in every list it always is:
 * `NotesLayout` writes it into a URL that arrives without one. That is what makes Back
 * honest. While a silent URL meant "whatever this device last chose", every such history
 * entry changed its meaning the moment the view was changed, and Back
 * landed on a page drawn differently from how it had been left. With the view spelled
 * out in each entry, an entry means what it meant.
 *
 * Storage is only the seed for a URL that has not said yet (a plain `/notes` link, a
 * notebook picked from All notebooks) so those open the way the list was last seen
 * rather than resetting. It follows the URL rather than the menu alone: the last view
 * *seen* is the one to carry forward, whether it came from the menu, from Back, or from
 * a bookmark, so the view never changes under someone who has not asked it to.
 *
 * It was per notebook at first, which was wrong in use (changing notebooks is how you
 * keep browsing, and a view that changed under the move read as the app forgetting), and
 * then storage alone, which was wrong in kind: the view is how you are looking, like the
 * sort, and a table of a notebook is worth a bookmark.
 */
export function useNotesView(fromUrl: NotesViewMode | undefined): NotesViewMode {
  const [stored, setStored] = usePersistentState<NotesViewMode>('notesView', 'list', parseView);
  useEffect(() => {
    if (fromUrl !== undefined && fromUrl !== stored) setStored(fromUrl);
  }, [fromUrl, stored, setStored]);
  return fromUrl ?? stored;
}

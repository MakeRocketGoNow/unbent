import { usePersistentState } from './usePersistentState.js';
import type { NotesViewMode } from './useNotesLayout.js';

/**
 * Reads the stored view. It was briefly a map of notebook id to `'table'`; a browser still
 * holding that shape chose the table somewhere, so it reads as the table rather than as
 * nothing.
 */
function parseView(raw: unknown): NotesViewMode | undefined {
  if (raw === 'list' || raw === 'table') return raw;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return Object.values(raw).includes('table') ? 'table' : 'list';
  }
  return undefined;
}

/**
 * How the note list is drawn: the sidebar of entries, or the table of a notebook's fields.
 *
 * Two sources, in order. The URL's `view` wins when it says anything, because a link or a
 * bookmark that names a view has to mean it. When the URL is silent the answer is this
 * device's usual view, kept in storage, so a plain `/notes` link opens the way it was last
 * left rather than resetting to the list — the sort can afford to reset on a fresh visit,
 * since everyone accepts "recently updated"; someone who works in tables should not have
 * to ask for them again each time.
 *
 * It was storage alone at first, and per notebook before that. Per notebook was wrong in
 * use: changing notebooks is how you keep browsing, and a view that changed under the
 * move read as the app forgetting. Storage alone was wrong in kind: the view is how you
 * are looking, like the sort, and a table of a notebook is worth a bookmark.
 *
 * Returns the view in effect and the setter for the *remembered* one. Writing the URL is
 * the caller's, which owns the router; opening a link does not change what is remembered,
 * only choosing a view does.
 */
export function useNotesView(
  fromUrl: NotesViewMode | undefined,
): [NotesViewMode, (next: NotesViewMode) => void] {
  const [stored, setStored] = usePersistentState<NotesViewMode>('notesView', 'list', parseView);
  return [fromUrl ?? stored, setStored];
}

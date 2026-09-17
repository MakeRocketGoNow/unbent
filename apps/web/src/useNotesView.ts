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
 * One choice, not one per notebook. It was per notebook at first, on the reasoning that
 * the table is a fact about the notebook — Coupons is a table, a journal is not — and in
 * use that was wrong: changing notebooks is how you keep browsing, and a view that changed
 * underneath the move read as the app forgetting what it had just been told. The view is a
 * fact about how someone is working, like the sort, and like the sort it stays put until
 * they change it.
 *
 * Device-local like the pane widths: it is a statement about how this screen is used, and
 * a phone never draws the table at all. Where the table cannot be drawn — outside a
 * notebook, over search results — the caller draws the list and leaves this alone, so the
 * table is back the moment there is a notebook to draw it for.
 */
export function useNotesView(): [NotesViewMode, (next: NotesViewMode) => void] {
  return usePersistentState<NotesViewMode>('notesView', 'list', parseView);
}

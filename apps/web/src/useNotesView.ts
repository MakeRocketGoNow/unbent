import { useCallback } from 'react';
import { usePersistentState } from './usePersistentState.js';
import type { NotesViewMode } from './useNotesLayout.js';

/** The notebooks drawn as a table, by id. A notebook not listed is drawn as the list. */
type StoredViews = Record<string, 'table'>;

function parseViews(raw: unknown): StoredViews | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: StoredViews = {};
  for (const [id, mode] of Object.entries(raw)) if (mode === 'table') out[id] = 'table';
  return out;
}

/**
 * How a notebook's list is drawn: the sidebar of entries, or the table of its fields.
 *
 * Remembered per notebook rather than as one switch, because the table is a fact about
 * the notebook — Coupons is a table, a journal is not — and one global flag would be
 * flipped on every move between the two. Keyed by id rather than the name the URL
 * carries, since names rename. Device-local like the pane widths: it is a statement about
 * how this screen is used, and a phone never draws the table at all.
 *
 * Outside a notebook there is nothing to remember against, so the view is the list and
 * setting it is a no-op; the toggle is disabled there and says why.
 */
export function useNotesView(
  notebookId: string | undefined,
): [NotesViewMode, (next: NotesViewMode) => void] {
  const [stored, setStored] = usePersistentState<StoredViews>('notesView', {}, parseViews);
  const view: NotesViewMode =
    notebookId !== undefined && stored[notebookId] === 'table' ? 'table' : 'list';

  const setView = useCallback(
    (next: NotesViewMode) => {
      if (notebookId === undefined) return;
      setStored((prev) => {
        const copy = { ...prev };
        if (next === 'table') copy[notebookId] = 'table';
        else delete copy[notebookId];
        return copy;
      });
    },
    [notebookId, setStored],
  );

  return [view, setView];
}

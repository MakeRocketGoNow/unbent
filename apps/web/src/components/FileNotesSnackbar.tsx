import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { undoFileNotes, useFileNotes, type FileNotesState } from '../file-notes.js';
import { Snackbar } from './Snackbar.js';

const IMPORT_PAGE = '/settings/import';

/**
 * The batch of notes being made from files, wherever the person is.
 *
 * `ImportSnackbar`'s shape, for the same reason: the uploads outlive the drop that
 * started them, and twelve PDFs take long enough that the person has moved on. Progress
 * while they land, then "12 notes added" with Undo — the afterthought path, beside the
 * selection the list makes of the same notes. Undo trashes the batch, where it can still
 * be restored, and the card goes with the press, as `Snackbar`'s action does; the rows
 * leaving the list are the word that it worked.
 *
 * Not on the Import page, which draws the same batch inline where it was started. A
 * clean batch clears itself; one that stopped short stays, like any failure, and still
 * offers Undo, since three notes of twelve are more often a wrong drop to take back than
 * a job to finish by hand.
 */
export function FileNotesSnackbar() {
  const state = useFileNotes();
  const queryClient = useQueryClient();
  const onImportPage = useRouterState({ select: (s) => s.location.pathname === IMPORT_PAGE });
  // Dismissed per run and status: hiding a run's progress still lets its outcome through.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = `${state.run}:${state.status}`;

  if (state.status === 'idle' || onImportPage || dismissed === key) return null;
  const onDismiss = () => setDismissed(key);
  const undo = { label: 'Undo', onClick: () => void undoFileNotes(queryClient) };

  switch (state.status) {
    case 'running':
      return <Snackbar message={`Adding ${notes(state.total)} · ${state.done} of ${state.total}`} tone="info" onDismiss={onDismiss} />;
    case 'done':
      return (
        <Snackbar
          message={doneMessage(state)}
          tone="info"
          action={undo}
          // Longer than a one-line result's six seconds: the card lands after a batch the
          // person may have looked away from, and Undo is what it is there for.
          duration={8000}
          onDismiss={onDismiss}
        />
      );
    case 'error':
      return (
        <Snackbar
          message={`${state.done === 0 ? 'No notes added' : `${notes(state.done)} of ${state.total} added`}; the rest failed: ${state.error}`}
          tone="error"
          action={state.done > 0 ? undo : undefined}
          onDismiss={onDismiss}
        />
      );
  }
}

function notes(n: number): string {
  return `${n.toLocaleString()} note${n === 1 ? '' : 's'}`;
}

function doneMessage(state: FileNotesState): string {
  return `${notes(state.ids.length)} added${state.place ? ` to ${state.place}` : ''}.`;
}

import { useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { useImportRun, type ImportRunState } from '../import-run.js';
import { importPercent } from './import-progress.js';
import { Snackbar } from './Snackbar.js';

const IMPORT_PAGE = '/settings/import';

/**
 * The running import, wherever the person is.
 *
 * An import used to hold the whole app still while it ran: the rail and the settings
 * pages went inert, because leaving the import page ended the run. Now that the run
 * outlives the page (`import-run.ts`), people can go back to their notes during a long
 * one, and something has to say it is still going and how it ended. The export already
 * has this in `ExportSnackbar`, and the import takes the same shape so the two read as
 * one pattern: a card at the bottom, not on the page it describes, dismissable per run.
 *
 * The one thing to do is go and look (the counts, the failures and the skipped notes
 * are on the import page and nowhere else), so its action is a link there rather than a
 * Stop. Stopping stays on that page, beside what it would stop.
 *
 * A finished run with failures stays until dismissed, like any failure; a clean one
 * clears itself. Progress moves in steps of five percent, because this is a live region
 * and one that changed with every note would talk over everything else.
 */
export function ImportSnackbar() {
  const state = useImportRun();
  const onImportPage = useRouterState({ select: (s) => s.location.pathname === IMPORT_PAGE });
  // Dismissed per run and status: hiding a run's progress still lets its outcome through.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = `${state.run}:${state.status}`;

  if (state.status === 'idle' || onImportPage || dismissed === key) return null;
  const onDismiss = () => setDismissed(key);
  const link = { label: 'View', to: IMPORT_PAGE } as const;

  switch (state.status) {
    case 'running':
      return <Snackbar message={runningMessage(state)} tone="info" link={link} onDismiss={onDismiss} />;
    case 'done': {
      const failed = state.progress?.failed ?? 0;
      return (
        <Snackbar
          message={doneMessage(state)}
          tone={failed > 0 ? 'error' : 'info'}
          link={link}
          duration={failed > 0 ? undefined : 6000}
          onDismiss={onDismiss}
        />
      );
    }
    case 'error':
      return (
        <Snackbar
          message={`The import stopped: ${state.error}`}
          tone="error"
          link={link}
          onDismiss={onDismiss}
        />
      );
  }
}

function notes(n: number): string {
  return `${n.toLocaleString()} note${n === 1 ? '' : 's'}`;
}

/**
 * A percentage only when the run knows how many notes there are, which an archive does.
 * An ENEX is measured in bytes read (`importPercent`), and the parser reads well ahead of
 * the uploads: a small file said 100% here while most of its notes were still to come.
 * On the page that sits beside live counts; alone in this card it read as finished.
 */
function runningMessage(state: ImportRunState): string {
  const what = `Importing ${state.file?.name ?? 'notes'}`;
  if (!state.progress?.notesTotal) return `${what}…`;
  const percent = Math.floor(importPercent(state.progress, 0, false) / 5) * 5;
  return `${what} · ${percent}%`;
}

function doneMessage(state: ImportRunState): string {
  const created = state.progress?.created ?? 0;
  const failed = state.progress?.failed ?? 0;
  return `Imported ${notes(created)}${failed > 0 ? `; ${failed.toLocaleString()} failed` : ''}.`;
}

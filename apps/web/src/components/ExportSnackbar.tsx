import { useRef, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import type { ExportFilter } from '@unbent/shared';
import { savedAs, stopExport, useExporting, type ExportState } from '../export-archive.js';
import { Snackbar } from './Snackbar.js';

/**
 * The running export, wherever the person is.
 *
 * An export can be started from three places — the export page, the note list's filters
 * and a notebook's download in Settings — and only the export page had room to say how
 * it was going. From the other two a failure was silent: the label went back to what it
 * was and nothing said the backup had not been made. A notebook download in a browser
 * without a save picker showed nothing at all until the zip arrived, and there was no
 * way to stop one without going to the export page.
 *
 * A snackbar rather than a status line beside each button, because a run outlives the
 * page it was started from: a person who starts a notebook's export and goes back to
 * their notes still needs to hear that it failed. It also lands without moving anything
 * — a line appearing above the notebook list would push every row down under the
 * pointer. Not on the export page itself, which says all of this beside its button.
 *
 * Progress is shown in steps of five percent rather than per note: the snackbar is a live
 * region, and one that changed thousands of times would talk over everything else.
 *
 * How a run ended stays until it is dismissed — the saved file's name as much as a
 * failure. An export of an archive takes long enough that nobody watches it finish: they
 * start it and go back to their notes or another tab, and a "Saved" that cleared itself
 * after six seconds was gone before they looked. The one outcome that still clears itself
 * is "stopped", because the person pressed Stop and is looking right at it.
 */
export function ExportSnackbar() {
  const state = useExporting();
  const onExportPage = useRouterState({ select: (s) => s.location.pathname === '/settings/export' });
  // Dismissed per run and status: hiding a running export's progress still lets its
  // outcome through, and a dismissed outcome does not hide the next run's.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = `${state.run}:${state.status}`;
  // `Snackbar` dismisses itself after any action, which suits an Undo. Stop is not done
  // when clicked — the request in flight has to land first — so its dismiss is skipped
  // and the card stays to say it is stopping, then how it ended.
  const stopping = useRef(false);

  if (state.status === 'idle' || onExportPage || dismissed === key) return null;
  const onDismiss = () => {
    if (stopping.current) stopping.current = false;
    else setDismissed(key);
  };
  const stop = () => {
    stopping.current = true;
    stopExport();
  };

  switch (state.status) {
    case 'running':
      return (
        <Snackbar
          message={runningMessage(state)}
          tone="info"
          action={state.stopping ? undefined : { label: 'Stop', onClick: stop }}
          onDismiss={onDismiss}
        />
      );
    case 'done':
      return (
        <Snackbar message={savedAs(state)} tone="info" onDismiss={onDismiss} />
      );
    case 'stopped':
      return (
        <Snackbar message="Export stopped. Nothing was saved." tone="info" duration={4000} onDismiss={onDismiss} />
      );
    case 'error':
      return (
        <Snackbar
          message={`The export failed: ${state.error}. Nothing was saved.`}
          tone="error"
          onDismiss={onDismiss}
        />
      );
  }
}

/** What is being exported, in the words the place that started it used. */
function subject(filter: ExportFilter | null): string {
  if (filter?.notebook) return filter.notebook;
  const filtered =
    filter && ((filter.tags?.length ?? 0) > 0 || (filter.fields?.length ?? 0) > 0 || filter.from || filter.to);
  return filtered ? 'the filtered notes' : 'everything';
}

function runningMessage(state: ExportState): string {
  if (state.stopping) return 'Stopping the export…';
  const what = `Exporting ${subject(state.filter)}`;
  if (!state.total) return `${what}…`;
  const percent = Math.floor((state.done / state.total) * 20) * 5;
  return `${what} · ${percent}%`;
}

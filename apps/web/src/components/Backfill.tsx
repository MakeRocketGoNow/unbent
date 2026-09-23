import { startIndexing, stopIndexing, useIndexing, type IndexingState } from '../index-files.js';
import { Button } from './Button.js';

interface BackfillProps {
  /** Whether this instance reads images with a vision model; `AppConfig.vision`. */
  vision: boolean;
}

/** `12 images`, `1,356 images`. */
function images(n: number): string {
  return `${n.toLocaleString()} image${n === 1 ? '' : 's'}`;
}

/**
 * One line beside the button. The app may have run a pass on its own before this panel was
 * opened, so every state the store can be in has a sentence here, not only the ones the
 * button itself leads to.
 */
function indexingText(state: IndexingState, vision: boolean): string {
  const p = state.progress;
  const i = state.images;
  switch (state.status) {
    case 'idle':
      // The cost is named up front where there is one: each image is a paid request.
      return vision
        ? 'For files added before PDF or image search existed. Images are read one request each.'
        : 'For notes imported before PDF search existed.';
    case 'running': {
      // The file or request in flight is left to land — see `Indexing.stop` — and that
      // takes seconds, so the press has to be seen to have registered before anything moves.
      if (state.phase === 'images') {
        const left = i ? `, ${i.remaining.toLocaleString()} left` : '';
        return state.stopping
          ? `Stopping after the current request… ${i?.read ?? 0} read${left}`
          : `Reading images… ${i?.read ?? 0} read${left}`;
      }
      const of = p?.total ? ` / ${p.total.toLocaleString()}` : '';
      return state.stopping
        ? `Stopping after the current file… ${p?.done ?? 0}${of}`
        : `Indexing PDFs… ${p?.done ?? 0}${of}`;
    }
    case 'done':
      return (
        `Done. Indexed ${p?.indexed ?? 0} of ${p?.done ?? 0} PDFs.` +
        (i ? ` Read ${images(i.read)}.` : '') +
        (p?.failed ? ` ${p.failed} could not be read and will be tried again.` : '')
      );
    case 'stopped':
      // What it got through, then what it left: the numbers say whether to press again.
      if (state.phase === 'images') {
        return `Stopped. Read ${images(i?.read ?? 0)}${i?.remaining ? `, ${i.remaining.toLocaleString()} left` : ''}.`;
      }
      return (
        `Stopped. Indexed ${p?.indexed ?? 0} of ${p?.done ?? 0} PDFs` +
        (p && p.total > p.done ? `; ${(p.total - p.done).toLocaleString()} left` : '') +
        '.'
      );
    case 'deferred':
      return `${state.remaining} PDFs are not searchable yet.`;
    case 'error':
      return state.error ?? 'Indexing failed.';
  }
}

/**
 * The pass over files already here — the PDFs the browser can read, and with a vision
 * model the images the server can — and its one control.
 *
 * Stop takes the button's place rather than appearing beside it: the row has one slot for
 * an action, and while a pass runs the action is ending it. The slot keeps its width
 * across the swap (`.backfill-row .btn`) so the line of text beside it stays put. A pass
 * the app started on its own shows the same Stop; the person watching it is entitled to
 * end it whoever began it.
 */
export function Backfill({ vision }: BackfillProps) {
  const indexing = useIndexing();
  return (
    <div className="backfill-row">
      {indexing.status === 'running' ? (
        <Button size="small" tone="danger" disabled={indexing.stopping} onClick={stopIndexing}>
          Stop
        </Button>
      ) : (
        <Button size="small" onClick={() => startIndexing({ auto: false, images: vision })}>
          {vision ? 'Index existing files' : 'Index existing PDFs'}
        </Button>
      )}
      <span className={indexing.status === 'error' ? 'bad small' : 'muted small'}>
        {indexingText(indexing, vision)}
      </span>
    </div>
  );
}

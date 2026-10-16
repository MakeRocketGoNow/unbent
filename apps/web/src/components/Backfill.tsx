import { startIndexing, stopIndexing, useIndexing, type IndexingState } from '../index-files.js';
import { Button } from './Button.js';

const PDF_OFFER = 'For notes imported before PDF search existed. Read here, in the browser.';

/**
 * The row's line. The app may have run this pass on its own before the panel was opened,
 * so every state the store can be in has a sentence here, not only the ones the button
 * leads to.
 */
function pdfText(state: IndexingState): string {
  const p = state.progress;
  switch (state.status) {
    case 'idle':
      return PDF_OFFER;
    case 'running': {
      // The file in flight is left to finish (see `Indexing.stop`), so the press has to
      // be seen to have registered before anything moves.
      const of = p?.total ? ` / ${p.total.toLocaleString()}` : '';
      return state.stopping
        ? `Stopping after the current file… ${p?.done ?? 0}${of}`
        : `Indexing PDFs… ${p?.done ?? 0}${of}`;
    }
    case 'done':
      return (
        `Done. Indexed ${p?.indexed ?? 0} of ${p?.done ?? 0} PDFs.` +
        (p?.failed ? ` ${p.failed} could not be read and will be tried again.` : '')
      );
    case 'stopped':
      // What it got through, then what it left: the numbers say whether to press again.
      return (
        `Stopped. Indexed ${p?.indexed ?? 0} of ${p?.done ?? 0} PDFs` +
        (p && p.total > p.done ? `; ${(p.total - p.done).toLocaleString()} left` : '') +
        '.'
      );
    case 'deferred':
      return `${state.remaining.toLocaleString()} PDFs are not searchable yet.`;
    case 'error':
      return state.error ?? 'Indexing failed.';
  }
}

/**
 * The pass over the PDFs already here, which the browser reads for free. Drawn by
 * Maintenance, beside the orphaned-files sweep, because that is what it is: housekeeping
 * over every file the account holds, however it arrived. It started under Import, where
 * it read as a step of importing and sat as a footnote under its form.
 *
 * A second row sat under this one until MAK-179: "Read N images", a paid pass on the
 * server over every picture and text-less scan the account held, with the count as its
 * price on the button. It went when the language model was confined to Auto-fill, which
 * reads a note's own pictures when a person presses it; nothing a pass over the whole
 * account could spend is left to offer.
 *
 * Stop takes the button's place rather than appearing beside it: the row has one slot
 * for an action, and while the pass runs the action is ending it. The slot keeps its
 * width across the swap (`.backfill-row .btn`) so the text beside it stays put.
 */
export function Backfill() {
  const indexing = useIndexing();
  const running = indexing.status === 'running';
  return (
    <div className="backfill">
      <div className="backfill-row">
        {running ? (
          <Button size="small" tone="danger" disabled={indexing.stopping} onClick={stopIndexing}>
            Stop
          </Button>
        ) : (
          <Button size="small" onClick={() => startIndexing({ auto: false })}>
            Index existing PDFs
          </Button>
        )}
        <span className={indexing.status === 'error' ? 'bad small' : 'muted small'}>{pdfText(indexing)}</span>
      </div>
    </div>
  );
}

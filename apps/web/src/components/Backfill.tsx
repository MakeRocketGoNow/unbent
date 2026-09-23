import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readImages, startIndexing, stopIndexing, useIndexing, type IndexingState } from '../index-files.js';
import { keys, pendingImagesQuery } from '../queries.js';
import { Button } from './Button.js';

interface BackfillProps {
  /** Whether this instance reads images with a vision model; `AppConfig.vision`. */
  vision: boolean;
}

/** `12 images`, `1,356 images`. */
function images(n: number): string {
  return `${n.toLocaleString()} image${n === 1 ? '' : 's'}`;
}

const PDF_OFFER = 'For notes imported before PDF search existed. Read here, in the browser.';
// The cost is named before the press: each file is a paid request, and stopping is free.
const IMAGE_OFFER =
  'Pictures, and scans with no text layer, read by the vision model on the server. ' +
  'Each is one paid request; stop at any time.';

/**
 * The PDF row's line. The app may have run this pass on its own before the panel was
 * opened, so every state the store can be in has a sentence here, not only the ones the
 * button leads to. A pass over the images is the other row's news, and this row goes
 * back to its offer while one runs or after one ran.
 */
function pdfText(state: IndexingState): string {
  const p = state.progress;
  if (state.phase === 'images') return PDF_OFFER;
  switch (state.status) {
    case 'idle':
      return PDF_OFFER;
    case 'running': {
      // The file in flight is left to finish — see `Indexing.stop` — so the press has to
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

/** The image row's line; the PDF pass is the other row's news. */
function imageText(state: IndexingState): string {
  const i = state.images;
  const left = i?.remaining ? `, ${i.remaining.toLocaleString()} left` : '';
  if (state.phase !== 'images') return IMAGE_OFFER;
  switch (state.status) {
    case 'idle':
    case 'deferred':
      // Neither happens to this pass; the switch is exhaustive so a new status is not missed.
      return IMAGE_OFFER;
    case 'running':
      // A request is a few files the server has been asked for; it lands before the stop does.
      return state.stopping
        ? `Stopping after the current request… ${i?.read ?? 0} read${left}`
        : `Reading images… ${i?.read ?? 0} read${left}`;
    case 'done':
      return (
        `Done. Read ${images(i?.read ?? 0)}.` +
        // The pass ends itself when a request moves nothing; what is left could not be read.
        (i?.remaining ? ` ${i.remaining.toLocaleString()} could not be read and are left for next time.` : '')
      );
    case 'stopped':
      return `Stopped. Read ${images(i?.read ?? 0)}${left}.`;
    case 'error':
      return state.error ?? 'Reading failed.';
  }
}

/**
 * The passes over files already here: the PDFs the browser reads, and with a vision model
 * the images the server reads. One row each, because they are different choices — one is
 * free and local, the other is a paid request per file — and the second names its price
 * on the button. It was one button, "Index existing files", that ran both in turn; on a
 * real archive that committed the person to a thousand paid requests in a press.
 *
 * Stop takes the running row's button's place rather than appearing beside it: a row has
 * one slot for an action, and while its pass runs the action is ending it. The slots keep
 * their width across the swap (`.backfill-row .btn`) so the text beside them stays put.
 * The other row's button waits, disabled: the store runs one pass at a time.
 *
 * The image row is drawn only when there is something for it to read, or its pass has
 * news — a button for a pass with nothing to do is clutter on every instance without
 * pictures. Its count is the server's, asked on mount; a pass that ends leaves its own
 * last answer in the cache and asks the server again, since a PDF pass can add to the
 * count (a scan whose layer turned out empty is the model's next) as well as take from it.
 */
export function Backfill({ vision }: BackfillProps) {
  const indexing = useIndexing();
  const queryClient = useQueryClient();
  const pendingQuery = useQuery({ ...pendingImagesQuery(), enabled: vision });
  const pending = pendingQuery.data ?? 0;
  const running = indexing.status === 'running';

  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && vision) {
      if (indexing.phase === 'images') {
        if (indexing.images) queryClient.setQueryData(keys.pendingImages(), indexing.images.remaining);
        void queryClient.invalidateQueries({ queryKey: keys.pendingImages() });
      } else if (indexing.progress?.unusable) {
        // A scan whose text layer turned out empty is the model's next. A PDF pass that
        // found none — the pass on open, most days — changed nothing worth asking about.
        void queryClient.invalidateQueries({ queryKey: keys.pendingImages() });
      }
    }
    wasRunning.current = running;
  }, [running, vision, indexing.phase, indexing.images, indexing.progress, queryClient]);

  const stop = (
    <Button size="small" tone="danger" disabled={indexing.stopping} onClick={stopIndexing}>
      Stop
    </Button>
  );
  const tone = (phase: IndexingState['phase']) =>
    indexing.status === 'error' && indexing.phase === phase ? 'bad small' : 'muted small';

  return (
    <div className="backfill">
      <div className="backfill-row">
        {running && indexing.phase === 'pdfs' ? (
          stop
        ) : (
          <Button size="small" disabled={running} onClick={() => startIndexing({ auto: false })}>
            Index existing PDFs
          </Button>
        )}
        <span className={tone('pdfs')}>{pdfText(indexing)}</span>
      </div>
      {vision && (pending > 0 || indexing.phase === 'images') && (
        <div className="backfill-row">
          {running && indexing.phase === 'images' ? (
            stop
          ) : (
            <Button size="small" disabled={running || pending === 0} onClick={readImages}>
              {pending > 0 ? `Read ${images(pending)}` : 'Read images'}
            </Button>
          )}
          <span className={tone('images')}>{imageText(indexing)}</span>
        </div>
      )}
    </div>
  );
}

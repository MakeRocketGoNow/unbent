import { useFeedState } from '../store/use-feed-state.js';

/**
 * One line while the library is being copied to this device for the first time: an
 * archive is thousands of notes, and the list filling in page by page with nothing to
 * say it is on its way reads as a library with most of its notes missing. Quiet, in the
 * same place and voice as the offline line, and gone the moment the walk ends.
 *
 * The count is of notes applied against the total the first page reported; the rest of
 * the library — notebooks, tags — comes with that first page.
 */
export function LibraryStatus() {
  const state = useFeedState();
  if (!state || state.phase !== 'hydrating') return null;
  const total = state.total;
  return (
    <p className="offline-banner library-status" role="status">
      <span>
        {total ? `Copying your notes to this device… ${Math.min(state.applied, total)} of ${total}` : 'Copying your notes to this device…'}
      </span>
    </p>
  );
}

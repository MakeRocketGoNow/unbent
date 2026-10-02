import { useLibraryArriving } from '../store/use-feed-state.js';

/**
 * One line while the library is still arriving on this device: while the store opens,
 * and then while the notes are copied for the first time. An archive is thousands of
 * notes, and the list filling in page by page with nothing to say it is on its way reads
 * as a library with most of its notes missing — and before the first page, with nothing
 * at all, as an app that is broken. Quiet, in the same place and voice as the offline
 * line, and gone the moment the copy is on the device.
 *
 * The count is of notes applied against the total the first page reported; the rest of
 * the library — notebooks, tags — comes with that first page. Opening has no count yet.
 */
export function LibraryStatus() {
  const arriving = useLibraryArriving();
  if (!arriving) return null;
  const { stage, applied, total } = arriving;
  return (
    <p className="offline-banner library-status" role="status">
      <span>
        {stage === 'opening'
          ? 'Opening your notes…'
          : total
            ? `Copying your notes to this device… ${Math.min(applied, total)} of ${total}`
            : 'Copying your notes to this device…'}
      </span>
    </p>
  );
}

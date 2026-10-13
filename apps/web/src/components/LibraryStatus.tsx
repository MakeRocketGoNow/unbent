import { useLibraryArriving } from '../store/use-feed-state.js';

/** What Open here does to the tab it takes the library from, said on the button where it is drawn (Settings → Offline). */
export const OPEN_HERE_TIP = 'Moves your notes to this tab. The other tab or window keeps working, through this one.';

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
 *
 * Nothing here about which tab of this device holds the library. For a day in October
 * 2026 this line said "Your notes are open in another tab" with an Open here button —
 * at first on every view all day, which read as one tab at a time, then only offline,
 * where a second tab could neither read nor save. Now a tab that does not hold the
 * library is the holder's client and works as the holder does, offline included
 * (`store/client-library.ts`), so there is nothing for the chrome to say; Settings →
 * Offline still says which tab holds the file and offers to bring it here, with
 * `OPEN_HERE_TIP` on the button.
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

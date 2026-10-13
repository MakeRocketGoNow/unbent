import { useLibraryArriving } from '../store/use-feed-state.js';
import { useLibraryElsewhere } from '../store/use-outbox.js';
import { takeOverLibrary } from '../store/library.js';
import { useOffline } from '../connectivity.js';
import { Button } from './Button';

/** What Open here does to the tab it takes the library from, said on the button wherever it is drawn. */
export const OPEN_HERE_TIP = 'Moves your notes to this tab. The other tab or window keeps working, reading from the server instead.';

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
 * The same line says when another tab of this device holds the library
 * (`store/library-lock.ts`) — but only while this tab is offline. With a connection a
 * second tab works as the app always did, reading and writing the server, and a line
 * across the top of every view saying the notes were "open in another tab" made that
 * read as one tab at a time, which it is not; someone who works in several tabs saw it
 * all day. Offline is where the difference is real: this tab can neither read nor save,
 * and the way out is to take the library over, so the line and its button appear then,
 * under the banner that says why. Settings → Offline carries the same state and button
 * at all times, for anyone who wants the library here before going offline.
 *
 * A button, not a link: it changes which tab holds the library. Quiet, because the line
 * is a state, not an error. Its tip says what happens to the other tab, which is the one
 * consequence of the press that lands out of sight; the line itself stays short, and
 * says "tab" where the other one may be the installed app's window, which the tip
 * allows for.
 */
export function LibraryStatus() {
  const arriving = useLibraryArriving();
  const elsewhere = useLibraryElsewhere();
  const offline = useOffline();
  if (elsewhere && offline) {
    return (
      <p className="offline-banner library-status" role="status">
        <span>Your notes are open in another tab.</span>
        <Button
          variant="quiet"
          size="small"
          className="library-status-action"
          tip={OPEN_HERE_TIP}
          onClick={() => void takeOverLibrary()?.catch(() => {})}
        >
          Open here
        </Button>
      </p>
    );
  }
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

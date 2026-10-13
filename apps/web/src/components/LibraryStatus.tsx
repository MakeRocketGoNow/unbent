import { useLibraryArriving } from '../store/use-feed-state.js';
import { useLibraryElsewhere } from '../store/use-outbox.js';
import { takeOverLibrary } from '../store/library.js';
import { Button } from './Button';

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
 * (`store/library-lock.ts`): this tab reads the server meanwhile, which works with a
 * connection and not without one, and the way to take the library over is on the line
 * itself, since there is nowhere else anyone would look for it. A button, not a link: it
 * changes which tab holds the library. Quiet, because the line is a state, not an error.
 * Its tip says what happens to the other tab, which is the one consequence of the press
 * that lands out of sight; the line itself stays short, and says "tab" where the other
 * one may be the installed app's window, which the tip allows for.
 */
export function LibraryStatus() {
  const arriving = useLibraryArriving();
  const elsewhere = useLibraryElsewhere();
  if (elsewhere) {
    return (
      <p className="offline-banner library-status" role="status">
        <span>Your notes are open in another tab.</span>
        <Button
          variant="quiet"
          size="small"
          className="library-status-action"
          tip="Moves your notes to this tab. The other tab or window keeps working, reading from the server instead."
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

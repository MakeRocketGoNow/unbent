import { useOffline } from '../connectivity.js';
import { useLibraryPresence, useSyncStatus } from '../store/use-outbox.js';
import { OfflineIcon } from './icons.js';

/**
 * The one line that says the server is out of reach, across the top of the signed-in
 * column on every view.
 *
 * Placed in the column itself, after the top bar in source order, rather than attached to
 * that bar: the bar is hidden on the desktop and on most phone views, and a line that
 * lived inside it would say nothing to most people. Where the bar does show, the page
 * reads top to bottom: which app, then its state.
 *
 * Quiet on purpose: muted ink on a faint wash, not the danger colour and not the dark
 * snackbar. Nothing has gone wrong that anyone can fix, and the sentence already says what
 * still works: the library is on the device and note writes go to the outbox, so what
 * offline stops is search and files. It says it once and stays until the connection is
 * back; there is nothing to dismiss, because the state it describes is still true.
 *
 * The live region stays mounted and only its contents come and go, which is what makes a
 * screen reader announce the change; a region inserted already holding its text is often
 * read out by none of them.
 *
 * The second sentence is a promise only a tab whose outbox is durable can keep: the tab
 * holding the account's library, once it leads the outbox too, which it does a moment
 * after opening (`store/leader.ts`), and every tab that is that tab's client, whose
 * writes go to the same outbox and whose `durable` is the holder's, mirrored
 * (`store/client-library.ts`). A device with no library at all (a browser without the
 * file system it lives in) keeps nothing and queues nothing, and is told that and
 * nothing more; a library still opening is about to keep the promise, and gets it.
 * There used to be a line blaming "another Unbent tab" for the non-durable case; it
 * named a tab nobody could find, since the state it described lasted a moment. For a
 * day after one tab came to hold the library there was a line for a second tab too,
 * which could not save offline then; now it can, and the line is gone.
 */
export function OfflineBanner() {
  const offline = useOffline();
  const presence = useLibraryPresence();
  const { durable } = useSyncStatus();
  const line =
    presence === 'opening' || (presence === 'open' && durable)
      ? "You're offline. Your notes are here, and what you change will sync when you're back."
      : "You're offline. Changes can't be saved until you're back.";
  return (
    <div className="offline-status" role="status">
      {offline && (
        <p className="offline-banner">
          <OfflineIcon />
          <span>{line}</span>
        </p>
      )}
    </div>
  );
}

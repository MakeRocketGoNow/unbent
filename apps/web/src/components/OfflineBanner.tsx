import { useOffline } from '../connectivity.js';
import { useLibraryElsewhere, useLibraryPresence } from '../store/use-outbox.js';
import { OfflineIcon } from './icons.js';

/**
 * The one line that says the server is out of reach, across the top of the signed-in
 * column on every view.
 *
 * Placed in the column itself, after the top bar in source order, rather than attached to
 * that bar: the bar is hidden on the desktop and on most phone views, and a line that
 * lived inside it would say nothing to most people. Where the bar does show, the page
 * reads top to bottom — which app, then its state.
 *
 * Quiet on purpose — muted ink on a faint wash, not the danger colour and not the dark
 * snackbar. Nothing has gone wrong that anyone can fix, and the sentence already says what
 * still works: the library is on the device and note writes go to the outbox, so what
 * offline stops is search and files. It says it once and stays until the connection is
 * back; there is nothing to dismiss, because the state it describes is still true.
 *
 * The live region stays mounted and only its contents come and go, which is what makes a
 * screen reader announce the change; a region inserted already holding its text is often
 * read out by none of them.
 *
 * The second sentence is a promise the tab holding the library can keep: it holds the
 * outbox too, since one tab holds an account's library on a device (`store/library-lock.ts`)
 * and that tab leads its outbox (`store/leader.ts`). A tab without the library — another
 * tab has it — makes every write a request, and offline those fail; it says so, and says
 * where the notes are, since the status line beside it is where Open here is. A device
 * with no library at all (a browser without the file system it lives in) keeps nothing
 * and queues nothing, and is told what the old shell told it; a library still opening is
 * not that, and gets the promise, since it is about to keep it. There used to be a fourth
 * line, for a tab that held the library but not the outbox's lock, blaming "another
 * Unbent tab"; that state lasts a moment now, during a hand-over, and a line that showed
 * for a moment and named a tab nobody could find was the confusing one.
 */
export function OfflineBanner() {
  const offline = useOffline();
  const presence = useLibraryPresence();
  const elsewhere = useLibraryElsewhere();
  const line =
    presence === 'none'
      ? elsewhere
        ? "You're offline. Your notes are open in another tab, and changes can't be saved from this one until you're back."
        : "You're offline. Changes can't be saved until you're back."
      : "You're offline. Your notes are here, and what you change will sync when you're back.";
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

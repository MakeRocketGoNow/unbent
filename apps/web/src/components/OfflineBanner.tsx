import { useOffline } from '../connectivity.js';
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
 */
export function OfflineBanner() {
  const offline = useOffline();
  return (
    <div className="offline-status" role="status">
      {offline && (
        <p className="offline-banner">
          <OfflineIcon />
          <span>{"You're offline. Your notes are here, and what you change will sync when you're back."}</span>
        </p>
      )}
    </div>
  );
}

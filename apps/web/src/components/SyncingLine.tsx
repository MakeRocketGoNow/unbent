import { useEffect, useState } from 'react';
import { useOffline } from '../connectivity.js';
import { useSyncStatus } from '../store/use-outbox.js';

/** How long writes may wait, online, before the strip says so. A replay takes half a second. */
export const SLOW_SYNC_MS = 3000;

/**
 * One line in the status strip while writes have been waiting for the server for a
 * while with a connection there: the server having a bad minute. Not at once (a
 * replay takes half a second, and a line that flashed on every save would be noise),
 * and not offline, where the banner already says what will happen. Gone the moment
 * the outbox empties. With the glyph on the note and the question at sign-out, this is
 * the third and last place the outbox shows itself.
 */
export function SyncingLine({ delayMs = SLOW_SYNC_MS }: { delayMs?: number }) {
  const { pending } = useSyncStatus();
  const offline = useOffline();
  const waiting = !offline && pending > 0;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), delayMs);
    return () => clearTimeout(timer);
  }, [waiting, delayMs]);
  if (!slow || !waiting) return null;
  return (
    <p className="offline-banner library-status" role="status">
      <span>{`Syncing ${pending} change${pending === 1 ? '' : 's'}…`}</span>
    </p>
  );
}

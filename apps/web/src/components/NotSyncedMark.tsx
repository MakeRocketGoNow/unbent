import { useEffect, useState } from 'react';
import { NotSyncedIcon } from './icons.js';

/** How long a tap keeps the words up: long enough to read, gone before they are in the way. */
const SHOWN_MS = 2500;

/**
 * The glyph beside "Saved" for a note the server has not heard of yet, with its words
 * within reach: a tooltip on the desktop, and on a phone, where nothing hovers, a tap
 * shows the same words beside it for a moment. A button, so it has a name for a screen
 * reader and a target for a thumb; quiet, since it qualifies the word beside it rather
 * than asking for anything.
 */
export function NotSyncedMark() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(false), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  return (
    <button
      type="button"
      className="sync-mark"
      aria-label="Not synced yet"
      title="Not synced yet"
      aria-pressed={shown}
      onClick={() => setShown((s) => !s)}
    >
      <NotSyncedIcon />
      {shown && (
        <span className="sync-mark-tip" role="status">
          Not synced yet
        </span>
      )}
    </button>
  );
}

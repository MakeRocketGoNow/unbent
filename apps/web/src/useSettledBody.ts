import { useEffect, useState } from 'react';

/** How long typing has to pause before the body is read again. */
export const SETTLE_MS = 250;

/**
 * The note's body as it stood when typing last paused, for a reader that parses the
 * whole of it: the attachments panel's linked set and the "Save web images" count.
 *
 * A parse costs about a millisecond and a half per kilobyte, and these two readers
 * run on every change of the draft. Deferring the value (`useDeferredValue`) let the
 * keystroke paint first, but React starts the deferred render as soon as it has, and
 * cannot stop partway through a synchronous `useMemo`: while someone typed, the parse
 * ran back to back and every keystroke could wait on one. A timer waits for the pause
 * instead, so a burst of typing is one parse at its end.
 *
 * Settled with the note it belongs to. On a switch the last settled body is the
 * previous note's, and read against the new note's files it made every file look
 * unlinked for a render, which latched the panel open on every note with files (the
 * bug MAK-149 fixed, back by another route). A settled body from another note is not
 * answered: the live one is, once, on the switch, and settles from there.
 *
 * `flushKey` names what the body is read against, and a change to it is answered the
 * same way: the live body at once, and the pause only for what is typed after. A file
 * dropped into the note writes its link first and its row arrives a moment later, from
 * the feed; read against that row with the body still settling, the file was "not
 * linked" for a render, and the panel latched open on it (2026-10-29).
 */
export function useSettledBody(noteId: string, body: string, flushKey = '', pauseMs = SETTLE_MS): string {
  const [settled, setSettled] = useState({ noteId, body, flushKey });
  const stale = settled.noteId !== noteId || settled.flushKey !== flushKey;
  useEffect(() => {
    if (!stale && settled.body === body) return;
    const timer = setTimeout(() => setSettled({ noteId, body, flushKey }), stale ? 0 : pauseMs);
    return () => clearTimeout(timer);
  }, [noteId, body, flushKey, pauseMs, stale, settled.body]);
  return stale ? body : settled.body;
}

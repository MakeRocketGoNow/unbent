import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * Debounced autosave with a flush on note change, unmount, and tab hide.
 *
 * The flush matters more than the debounce: without it, edits made in the last debounce
 * window are lost when the user switches notes or closes the tab — exactly the moments a
 * notes app must not lose work. `visibilitychange` is used rather than `beforeunload`
 * because it is the one mobile browsers reliably fire.
 *
 * Note switches are not unmounts. Workspace and the embed keep this hook alive and pass a
 * new `resetKey`, so the outgoing edit has to be flushed here rather than waiting for a
 * cleanup that never runs. The save function is captured with the edit: by the time the
 * effect sees the new key, `save` already closes over the incoming note id.
 */
export function useAutosave<T>(
  value: T,
  /**
   * Writes the value, or answers `'unchanged'` when it finds nothing to write.
   *
   * The debounce fires on time elapsed, not on a change, so a draft can arrive here
   * identical to what the server already holds — a space typed and deleted is the usual
   * way. The callers diff before sending (see `buildNotePatch`) and return early when the
   * patch is empty; without a way to say so, that early return looked exactly like a
   * successful write and the head flashed "Saved" for a save that never happened.
   *
   * Returning nothing still means "written", so a save that does not care keeps working.
   */
  save: (value: T) => Promise<void | 'unchanged'>,
  opts: { delay?: number; enabled?: boolean; resetKey?: string } = {},
) {
  const { delay = 800, enabled = true, resetKey } = opts;

  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * A snapshot plus the save that belonged to it.
   *
   * `epoch` is how a failed in-flight save knows whether its snapshot is still the latest.
   * Restoring blindly would put an older body back over a newer one the user typed — or
   * over the incoming note's pending, if they switched while a save was failing.
   */
  const pending = useRef<{
    value: T;
    save: (value: T) => Promise<void | 'unchanged'>;
    epoch: number;
  } | null>(null);
  const epoch = useRef(0);
  const saveRef = useRef(save);
  saveRef.current = save;

  /**
   * The last value that must not be saved: the baseline the caller handed us.
   *
   * Render-order guards do not work here. The workspace mounts with an empty draft and
   * seeds it from the loaded note one render later, so "skip the first render" is spent
   * on the empty draft and the seeded value looks like an edit — which wrote every note
   * that was merely opened, rewriting `updated_at` and destroying the real modification
   * dates carried over from Evernote.
   *
   * Comparing against the baseline instead means only a value that differs from what was
   * seeded counts as an edit, whatever order the renders arrive in. `resetKey` (the note
   * id) re-arms it, so switching notes re-baselines rather than treating the incoming
   * seed as an edit of the outgoing draft.
   */
  const baseline = useRef<{ key: string | undefined; value: T } | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    if (next === null) return;
    pending.current = null;

    const baselineKey = baseline.current?.key;
    setState('saving');
    try {
      const outcome = await next.save(next.value);
      if (outcome === 'unchanged') {
        /*
           The save found nothing to write, so 'Saved' would be announcing work that never
           happened — the flash this exists to stop. 'idle' renders no label at all, which
           is the honest answer for a draft that matches what the server holds, and it also
           clears the 'Unsaved' a round-trip through an edit leaves behind.

           'saving' is still set above rather than held back until the outcome is known:
           the Android back handler waits for the state to leave 'saving'/'dirty' before
           letting the user leave the screen, so a real write must be visible there for the
           whole round-trip. 'idle' satisfies that wait, correctly — there is nothing to
           finish.

           The baseline still moves to this value. It is what the server has, so the next
           edit is measured against it; leaving it behind would make an identical draft
           look unsaved forever.
        */
        setState('idle');
        setError(null);
        if (baseline.current && baseline.current.key === baselineKey) {
          baseline.current.value = next.value;
        }
        return;
      }
      setState('saved');
      setError(null);
      /*
         What the server holds is now `next.value`, so that is the value an edit is
         measured against from here on. Left at the seed, a body that came back to exactly
         its loaded text after a save looked like "no edit" and was never sent — the
         server kept the intermediate version. Attaching a file makes that the common
         case: the upload's placeholder autosaves, and abandoning the upload restores
         the seed.

         Skip the write when the key moved during the await: the baseline now belongs to
         the incoming note, and putting the outgoing body there would make the incoming
         seed look like an edit — or worse, become the value a later flush measures
         against.
      */
      if (baseline.current && baseline.current.key === baselineKey) {
        baseline.current.value = next.value;
      }
    } catch (err) {
      setState('error');
      setError((err as Error).message);
      // Retry only if nothing newer has been queued or taken while this save was in flight.
      if (pending.current === null && epoch.current === next.epoch) {
        pending.current = next;
      }
    }
  }, []);

  useEffect(() => {
    const noteChanged = !baseline.current || baseline.current.key !== resetKey;

    if (noteChanged) {
      if (pending.current) void flush();
      if (!enabled) {
        // Drop the baseline so the first enabled value for this key is a seed.
        // Setting it to the still-showing outgoing draft would make the incoming
        // seed look like an edit, which is the Evernote-dates bug above.
        baseline.current = null;
        return;
      }
      baseline.current = { key: resetKey, value };
      return;
    }

    if (!enabled) return;
    const seeded = baseline.current;
    if (!seeded) return;
    // Re-seeding the same note with the same content (a refetch) is not an edit either.
    if (Object.is(seeded.value, value)) return;

    pending.current = { value, save: saveRef.current, epoch: ++epoch.current };
    setState('dirty');

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delay);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delay, enabled, flush, resetKey]);

  // Flush on tab hide and on unmount so leaving the page never drops the last edit.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      void flush();
    };
  }, [flush]);

  return { state, error, flush };
}

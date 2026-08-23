import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * Debounced autosave with a flush on unmount and on tab hide.
 *
 * The flush matters more than the debounce: without it, edits made in the last debounce
 * window are lost when the user switches notes or closes the tab — exactly the moments a
 * notes app must not lose work. `visibilitychange` is used rather than `beforeunload`
 * because it is the one mobile browsers reliably fire.
 */
export function useAutosave<T>(
  value: T,
  save: (value: T) => Promise<void>,
  opts: { delay?: number; enabled?: boolean; resetKey?: string } = {},
) {
  const { delay = 800, enabled = true, resetKey } = opts;

  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<T | null>(null);
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
   * id) re-arms it, so switching notes re-baselines rather than saving the outgoing note
   * over the incoming one.
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

    setState('saving');
    try {
      await saveRef.current(next);
      setState('saved');
      setError(null);
    } catch (err) {
      setState('error');
      setError((err as Error).message);
      // Keep the value pending so a later flush can retry it.
      pending.current = next;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    // First value for this note, or a note change: this is the baseline, not an edit.
    if (!baseline.current || baseline.current.key !== resetKey) {
      baseline.current = { key: resetKey, value };
      return;
    }
    // Re-seeding the same note with the same content (a refetch) is not an edit either.
    if (Object.is(baseline.current.value, value)) return;

    pending.current = value;
    setState('dirty');

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delay);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delay, enabled, flush, resetKey]);

  // Flush on tab hide and on unmount so switching notes never drops the last edit.
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

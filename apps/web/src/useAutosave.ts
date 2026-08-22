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
  opts: { delay?: number; enabled?: boolean } = {},
) {
  const { delay = 800, enabled = true } = opts;

  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<T | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Skip the save that would otherwise fire from the initial render.
  const primed = useRef(false);

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
    if (!primed.current) {
      primed.current = true;
      return;
    }

    pending.current = value;
    setState('dirty');

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delay);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delay, enabled, flush]);

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

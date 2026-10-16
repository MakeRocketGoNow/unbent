import { useCallback, useState } from 'react';

/** Everything this app stores in localStorage shares one namespace. */
const PREFIX = 'unbent.';

/**
 * State that survives a reload, in localStorage.
 *
 * Generalised from the hand-rolled `richEditor` toggle in the workspace, which read
 * storage in a lazy initialiser and wrote inside the setter updater. That shape is kept
 * deliberately: reading lazily means the value is right on the first paint rather than
 * flickering from a default, and writing in the setter rather than an effect means
 * mounting a component never rewrites what it just read.
 *
 * Values are JSON so that numbers come back as numbers: the pane widths need that, and a
 * bare `localStorage` string would have to be parsed at every call site instead.
 *
 * Both storage calls are guarded. Reading has to survive a hand-edited or half-written
 * value, and `setItem` throws outright in Safari private browsing; a lost pane width is
 * not worth taking the app down for.
 */
export function usePersistentState<T>(
  key: string,
  fallback: T,
  /**
   * Rejects values that parse but are no longer meaningful: a pane width from before the
   * clamps were retuned, say. Returning undefined falls back, which is what a fresh
   * browser would have done anyway.
   */
  parse?: (raw: unknown) => T | undefined,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    let raw: string | null;
    try {
      raw = localStorage.getItem(PREFIX + key);
    } catch {
      // Storage can be disabled entirely, not just full.
      return fallback;
    }
    if (raw === null) return fallback;

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return fallback;
    }
    if (parse) return parse(decoded) ?? fallback;
    return decoded as T;
  });

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          localStorage.setItem(PREFIX + key, JSON.stringify(resolved));
        } catch {
          // Quota or private browsing. The value still applies for this session.
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}

/** Keeps a resize within its track's limits. Exported for its own test: the drag that
 *  calls it is pointer-driven, and pointer capture is not worth simulating in jsdom. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

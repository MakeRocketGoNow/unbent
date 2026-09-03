import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutosave } from './useAutosave.js';

/**
 * Autosave must not fire for a value it was merely handed.
 *
 * The workspace is remounted per note and seeds its draft from the loaded note one render
 * after mount. A "skip the first render" guard is spent on the empty initial draft, so the
 * seeded value looks like an edit and every note is written just by being opened — which
 * silently rewrites `updated_at` and destroys the real modification dates carried over
 * from Evernote. `resetKey` is what makes the guard per-note instead of per-mount.
 */
describe('useAutosave priming', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not save the value it is seeded with', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    // Mirrors the workspace: autosave stays off until the note has loaded, so the seeded
    // draft — not the empty placeholder — is the first value autosave ever sees.
    const { rerender } = renderHook(
      ({ value, enabled }) => useAutosave(value, save, { delay: 10, enabled, resetKey: 'note-1' }),
      { initialProps: { value: 'empty', enabled: false } },
    );

    rerender({ value: 'loaded body', enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    expect(save).not.toHaveBeenCalled();
  });

  it('saves a real edit made after seeding', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ value, enabled }) => useAutosave(value, save, { delay: 10, enabled, resetKey: 'note-1' }),
      { initialProps: { value: 'empty', enabled: false } },
    );

    rerender({ value: 'loaded body', enabled: true });
    rerender({ value: 'loaded body, edited', enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('loaded body, edited');
  });

  it('re-primes when the note changes, so switching notes saves nothing', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    // Mirrors the workspace again: while the draft still holds the outgoing note's text,
    // `draftFor === noteId` is false and autosave is disabled. It re-enables only once
    // the incoming note has seeded the draft — which must not count as an edit.
    const { rerender } = renderHook(
      ({ value, resetKey, enabled }) => useAutosave(value, save, { delay: 10, enabled, resetKey }),
      { initialProps: { value: 'first body', resetKey: 'note-1', enabled: true } },
    );

    // Navigate: new id, draft not yet reseeded, so autosave is off.
    rerender({ value: 'first body', resetKey: 'note-2', enabled: false });
    // The incoming note seeds the draft and autosave comes back on.
    rerender({ value: 'second body', resetKey: 'note-2', enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    expect(save).not.toHaveBeenCalled();
  });

  /*
     The baseline moves with each save. Left at the seed, a body that came back to exactly
     its loaded text after a save looked like "no edit" and was never sent, so the server
     kept the intermediate version. Attaching a file makes that ordinary: the upload's
     placeholder autosaves, then abandoning the upload restores the seed.
  */
  it('saves a value that returns to the seed once something else was saved in between', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ value }) => useAutosave(value, save, { delay: 10, resetKey: 'note-1' }),
      { initialProps: { value: 'seed' } },
    );

    rerender({ value: 'seed with placeholder' });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(save).toHaveBeenLastCalledWith('seed with placeholder');

    rerender({ value: 'seed' });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('seed');
  });

  it('saves an edit to the second note, so re-priming does not disable autosave', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ value, resetKey, enabled }) => useAutosave(value, save, { delay: 10, enabled, resetKey }),
      { initialProps: { value: 'first body', resetKey: 'note-1', enabled: true } },
    );

    rerender({ value: 'first body', resetKey: 'note-2', enabled: false });
    rerender({ value: 'second body', resetKey: 'note-2', enabled: true });
    rerender({ value: 'second body, edited', resetKey: 'note-2', enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('second body, edited');
  });
});

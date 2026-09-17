import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutosave } from './useAutosave.js';

/**
 * Autosave must not fire for a value it was merely handed.
 *
 * Workspace stays mounted when the route param changes — it is the same instance with a
 * new note id — and seeds its draft from the loaded note one render after that. A "skip
 * the first render" guard is spent on the empty initial draft, so the seeded value looks
 * like an edit and every note is written just by being opened — which silently rewrites
 * `updated_at` and destroys the real modification dates carried over from Evernote.
 * `resetKey` is what makes the guard per-note instead of per-mount.
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

/**
 * Switching notes is not an unmount. The hook used to clear the debounce timer and leave
 * the outgoing edit in `pending`, then either drop it when the incoming note was edited
 * or flush it with the incoming note's save — writing one note's body onto another.
 */
describe('useAutosave note switches', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flushes an unsaved edit to the note it was typed in, not the one just opened', async () => {
    const saveFirst = vi.fn().mockResolvedValue(undefined);
    const saveSecond = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ value, resetKey, enabled, save }) =>
        useAutosave(value, save, { delay: 800, enabled, resetKey }),
      {
        initialProps: {
          value: 'first body',
          resetKey: 'note-1',
          enabled: true,
          save: saveFirst,
        },
      },
    );

    rerender({
      value: 'first body, edited',
      resetKey: 'note-1',
      enabled: true,
      save: saveFirst,
    });
    // Navigate before the debounce fires, the way clicking another note does.
    rerender({
      value: 'first body, edited',
      resetKey: 'note-2',
      enabled: false,
      save: saveSecond,
    });
    rerender({
      value: 'second body',
      resetKey: 'note-2',
      enabled: true,
      save: saveSecond,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(saveFirst).toHaveBeenCalledTimes(1);
    expect(saveFirst).toHaveBeenCalledWith('first body, edited');
    expect(saveSecond).not.toHaveBeenCalled();
  });

  it('does not write the outgoing edit onto the incoming note if the tab hides after the switch', async () => {
    const saveFirst = vi.fn().mockResolvedValue(undefined);
    const saveSecond = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ value, resetKey, enabled, save }) =>
        useAutosave(value, save, { delay: 800, enabled, resetKey }),
      {
        initialProps: {
          value: 'first body',
          resetKey: 'note-1',
          enabled: true,
          save: saveFirst,
        },
      },
    );

    rerender({
      value: 'first body, edited',
      resetKey: 'note-1',
      enabled: true,
      save: saveFirst,
    });
    rerender({
      value: 'first body, edited',
      resetKey: 'note-2',
      enabled: false,
      save: saveSecond,
    });
    rerender({
      value: 'second body',
      resetKey: 'note-2',
      enabled: true,
      save: saveSecond,
    });

    await act(async () => {
      await Promise.resolve();
    });
    saveFirst.mockClear();

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(saveFirst).not.toHaveBeenCalled();
    expect(saveSecond).not.toHaveBeenCalled();
  });
});

describe('useAutosave in-flight failure', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not replace a newer edit with the snapshot that just failed to save', async () => {
    let finishFirst!: (ok: boolean) => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            finishFirst = (ok) => (ok ? resolve() : reject(new Error('network')));
          }),
      )
      .mockResolvedValue(undefined);

    const { rerender, result } = renderHook(
      ({ value }) => useAutosave(value, save, { delay: 10, resetKey: 'note-1' }),
      { initialProps: { value: 'seed' } },
    );

    rerender({ value: 'first edit' });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(save).toHaveBeenCalledTimes(1);

    rerender({ value: 'second edit' });
    await act(async () => {
      finishFirst(false);
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.flush();
    });

    expect(save).toHaveBeenLastCalledWith('second edit');
    expect(save.mock.calls.at(-1)?.[0]).not.toBe('first edit');
  });
});

/**
 * A flush that turns out to have nothing to write must not claim it saved.
 *
 * The debounce fires on time elapsed rather than on a change, so a draft can reach the
 * save identical to what the server already holds — typing a space and deleting it is the
 * ordinary way. The callers diff before sending and answer `'unchanged'`; without that,
 * their early return looked exactly like a successful write and the head flashed "Saved"
 * for a save that never left the browser.
 *
 * The value here is an object, because that is what the workspace holds: a draft rebuilt
 * on every keystroke. The hook's own `Object.is` guard only catches a value handed back
 * by identity — a refetch — so a draft that returns to the stored *content* in a fresh
 * object still reaches the save, and only the save can tell there is nothing in it. (The
 * embed's body is a plain string and so is caught earlier, which is why that path never
 * flashed.)
 */
describe('useAutosave with nothing to save', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  interface Draft {
    body: string;
  }

  /** Drives the hook the way the workspace does: off until loaded, then seeded. */
  function seeded(save: (value: Draft) => Promise<void | 'unchanged'>) {
    const view = renderHook(
      ({ value, enabled }) => useAutosave(value, save, { delay: 10, enabled, resetKey: 'note-1' }),
      { initialProps: { value: { body: 'empty' } as Draft, enabled: false } },
    );
    view.rerender({ value: { body: 'Line one' }, enabled: true });
    return view;
  }

  it('does not say "saved" when the save reports it wrote nothing', async () => {
    const save = vi.fn().mockResolvedValue('unchanged');
    const { result, rerender } = seeded(save);

    // A space typed and taken back out: the draft moved, so the debounce fires...
    rerender({ value: { body: 'Line one ' }, enabled: true });
    rerender({ value: { body: 'Line one' }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    // ...the save is consulted, and answers that there was nothing to write.
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('still says "saved" when the save actually wrote', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = seeded(save);

    rerender({ value: { body: 'Line two' }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('saved');
  });

  it('clears the "unsaved" left by a round-trip rather than leaving it on screen', async () => {
    const save = vi.fn().mockResolvedValue('unchanged');
    const { result, rerender } = seeded(save);

    rerender({ value: { body: 'Line one!' }, enabled: true });
    // Mid-debounce the head honestly says there is unsaved work.
    expect(result.current.state).toBe('dirty');

    rerender({ value: { body: 'Line one' }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    // And once the save reports nothing to write, there is nothing outstanding to warn about.
    expect(result.current.state).toBe('idle');
  });

  it('reports an error even when the previous flush wrote nothing', async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce('unchanged')
      .mockRejectedValueOnce(new Error('network down'));
    const { result, rerender } = seeded(save);

    rerender({ value: { body: 'Line one ' }, enabled: true });
    rerender({ value: { body: 'Line one' }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.state).toBe('idle');

    // A failure after a no-op must still surface; the no-op path must not swallow it.
    rerender({ value: { body: 'Line three' }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('network down');
  });

  it('leaves the state settled and still saves the next real edit', async () => {
    const save = vi
      .fn<(value: Draft) => Promise<void | 'unchanged'>>()
      .mockResolvedValue('unchanged');
    const { result, rerender } = seeded(save);

    rerender({ value: { body: 'Line one ' }, enabled: true });
    rerender({ value: { body: 'Line one' }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.state).toBe('idle');

    /*
       A further draft object holding that same content still reaches the save: the
       baseline compares by identity, so only a value handed back by reference (a refetch)
       is skipped here. The save answers 'unchanged' again and nothing goes to the network,
       which is the property that matters — the workspace only rebuilds its draft on a
       keystroke, so this is not a render loop.
    */
    rerender({ value: { body: 'Line one' }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current.state).toBe('idle');

    // And a genuine edit after any number of no-ops still saves.
    save.mockResolvedValue(undefined);
    rerender({ value: { body: 'Line four' }, enabled: true });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(save).toHaveBeenLastCalledWith({ body: 'Line four' });
    expect(result.current.state).toBe('saved');
  });
});

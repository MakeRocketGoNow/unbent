import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reportError, installErrorReporting, resetErrorReporting } from './report-error.js';

/**
 * The reporter's failure modes, which are all worse than the errors it reports.
 *
 * A reporter that throws buries the exception it was called for; one that reports its own
 * network failures loops against the server; one without a cap turns a render loop into a
 * denial of service aimed at ourselves. Each is pinned below, because none of them would
 * be noticed by reading the code that is supposed to prevent them.
 */
describe('reportError', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetErrorReporting();
    fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const bodyOf = (call: number) =>
    JSON.parse((fetchMock.mock.calls[call]?.[1] as RequestInit).body as string);

  it('posts the message and kind', () => {
    reportError(new Error('boom'), 'error');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/client-errors');
    expect(bodyOf(0)).toMatchObject({ message: 'boom', kind: 'error' });
  });

  /** Rule 2: a failing send that reports its own failure never stops. */
  it('swallows its own network failure rather than reporting it', async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error('offline')));

    expect(() => reportError(new Error('boom'), 'error')).not.toThrow();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** Rule 3: a component throwing on every render must not become a request per render. */
  it('sends one report per distinct message', () => {
    for (let i = 0; i < 50; i += 1) reportError(new Error('same'), 'error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops after the cap even when every message differs', () => {
    for (let i = 0; i < 50; i += 1) reportError(new Error(`different ${i}`), 'error');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  /** Rule 1: anything thrown here re-enters the handler that called it. */
  it('does not throw on a value whose serialization throws', () => {
    const hostile = {
      get message() {
        throw new Error('nope');
      },
    };
    expect(() => reportError(hostile, 'rejection')).not.toThrow();
  });

  it('reports a rejected non-Error value', () => {
    reportError('plain string reason', 'rejection');
    expect(bodyOf(0)).toMatchObject({ message: 'plain string reason', kind: 'rejection' });
  });

  /**
   * The log exists to find broken code, not to record what anyone was reading. A note id
   * in the path would do the second, so it is replaced before the report leaves.
   */
  it('strips a note id from the route', () => {
    vi.stubGlobal('location', {
      pathname: '/notes/3f8a1c2e-1111-2222-3333-444455556666',
      href: 'http://x/notes/3f8a1c2e-1111-2222-3333-444455556666?q=secret',
    });

    reportError(new Error('boom'), 'error');

    const body = bodyOf(0);
    expect(body.route).toBe('/notes/:id');
    expect(JSON.stringify(body)).not.toContain('3f8a1c2e');
    // The query string never travels either; it can carry a search term.
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('truncates a very long stack', () => {
    const err = new Error('boom');
    err.stack = 'x'.repeat(10_000);

    reportError(err, 'error');

    expect(bodyOf(0).stack.length).toBeLessThanOrEqual(4000);
  });
});

describe('installErrorReporting', () => {
  beforeEach(() => {
    resetErrorReporting();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('removes both handlers on teardown', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    const teardown = installErrorReporting();
    expect(add).toHaveBeenCalledWith('error', expect.any(Function));
    expect(add).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));

    teardown();
    expect(remove).toHaveBeenCalledWith('error', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));

    add.mockRestore();
    remove.mockRestore();
  });
});

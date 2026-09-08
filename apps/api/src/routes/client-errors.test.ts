import { describe, it, expect, vi, afterEach } from 'vitest';
import { clientErrors } from './client-errors.js';

/**
 * The endpoint is unauthenticated and reachable from anywhere, so what it refuses is the
 * only thing standing between a log that is useful and one that is a dumping ground. These
 * pin the refusals rather than the happy path.
 */
describe('POST /client-errors', () => {
  afterEach(() => vi.restoreAllMocks());

  const post = (body: unknown) =>
    clientErrors.request('/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'test-agent' },
      body: JSON.stringify(body),
    });

  const valid = { message: 'boom', kind: 'error' as const };

  it('accepts a report and answers 204 with no body', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(valid);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(log).toHaveBeenCalledOnce();
  });

  /** One line, because Workers Logs indexes a line at a time. */
  it('logs the report and the request user agent as one JSON line', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    await post({ ...valid, route: '/notes/:id', stack: 'at foo' });

    const logged = JSON.parse(log.mock.calls[0]?.[1] as string);
    expect(logged).toMatchObject({
      kind: 'error',
      message: 'boom',
      route: '/notes/:id',
      stack: 'at foo',
      userAgent: 'test-agent',
    });
    // Anonymous unless a session resolved, which is the point of not gating this.
    expect(logged.userId).toBeNull();
  });

  it('rejects a message longer than the cap', async () => {
    const res = await post({ ...valid, message: 'x'.repeat(1001) });
    expect(res.status).toBe(400);
  });

  it('rejects an empty message', async () => {
    expect((await post({ ...valid, message: '   ' })).status).toBe(400);
  });

  it('rejects a kind it does not know', async () => {
    expect((await post({ ...valid, kind: 'whatever' })).status).toBe(400);
  });

  /** `.strict()`, so a caller cannot smuggle extra fields into the log. */
  it('rejects unknown fields rather than logging them', async () => {
    expect((await post({ ...valid, note: 'private content' })).status).toBe(400);
  });

  it('rejects an oversized stack', async () => {
    expect((await post({ ...valid, stack: 'x'.repeat(4001) })).status).toBe(400);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CaptureResult } from 'posthog-js';

vi.mock('posthog-js', () => ({
  default: { init: vi.fn(), captureException: vi.fn() },
}));

const posthog = (await import('posthog-js')).default;
const { installPosthog, scrub } = await import('./posthog.js');
const { reportError, resetErrorReporting } = await import('./report-error.js');

const CONFIG = { key: 'phc_x', uiHost: 'https://us.posthog.com' };

/**
 * PostHog is here to group exceptions and to do nothing else. These pin the two halves of
 * that: an `init` with every capture path switched off, and a `before_send` that drops
 * anything which is not an exception even so, because a default that changes in a future
 * version must not quietly turn a notes app into a tracked one.
 */
describe('posthog', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetErrorReporting();
    fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('initialises with every capture path but exceptions switched off', async () => {
    await installPosthog(CONFIG);

    expect(posthog.init).toHaveBeenCalledTimes(1);
    const [key, options] = vi.mocked(posthog.init).mock.calls[0] ?? [];
    expect(key).toBe('phc_x');
    expect(options).toMatchObject({
      defaults: '2026-05-30',
      cookieless_mode: 'always',
      person_profiles: 'never',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      respect_dnt: true,
      ui_host: CONFIG.uiHost,
    });
    // Same origin, so a content blocker does not drop the reports.
    expect(String(options?.api_host)).toMatch(/\/ingest$/);
    // The SDK's own exception autocapture stays off: report-error.ts already listens, and
    // its cap and duplicate filter are what keep a render loop from becoming a flood.
    // Off by name: left unset, the SDK defers to the project's remote setting, which turned
    // it on and reported every error twice.
    expect(options?.capture_exceptions).toBe(false);
  });

  it('forwards a report, with the thrown value PostHog can parse into frames', async () => {
    await installPosthog(CONFIG);
    const err = new Error('boom');

    reportError(err, 'error');

    expect(posthog.captureException).toHaveBeenCalledTimes(1);
    expect(posthog.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ kind: 'error' }),
    );
    // Additional, not instead: the Worker's log still gets it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing on an instance that never installed it', () => {
    reportError(new Error('boom'), 'error');

    expect(posthog.captureException).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops every event that is not an exception', () => {
    expect(scrub(null)).toBeNull();
    expect(scrub({ event: '$pageview', properties: {} } as unknown as CaptureResult)).toBeNull();
    expect(scrub({ event: '$survey shown', properties: {} } as unknown as CaptureResult)).toBeNull();
  });

  /* The same redaction the first-party report applies: a note id says which note someone
     was reading, and a query string can carry what they searched for. */
  it('strips the note id, the query string and the referrer from an exception', () => {
    vi.stubGlobal('location', {
      pathname: '/notes/3f8a1c2e-1111-2222-3333-444455556666',
      origin: 'http://localhost',
    });

    const event = scrub({
      event: '$exception',
      properties: {
        $current_url: 'http://localhost/notes/3f8a1c2e-1111-2222-3333-444455556666?q=secret',
        $referrer: 'http://localhost/notes/other',
      },
    } as unknown as CaptureResult);

    expect(event?.properties['$current_url']).toBe('/notes/:id');
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('3f8a1c2e');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('other');
  });

  /* Everything reaches PostHog through captureException, which marks an error handled;
     everything this app reports is something nothing caught. */
  it('marks every exception unhandled, keeping the rest of its mechanism', () => {
    const event = scrub({
      event: '$exception',
      properties: {
        $exception_list: [
          { type: 'Error', value: 'boom', mechanism: { type: 'generic', handled: true } },
          { type: 'Error', value: 'cause' },
        ],
      },
    } as unknown as CaptureResult);

    expect(event?.properties['$exception_list']).toEqual([
      { type: 'Error', value: 'boom', mechanism: { type: 'generic', handled: false } },
      { type: 'Error', value: 'cause', mechanism: { handled: false } },
    ]);
  });

  /* No error tracking is a worse outcome than having it; a broken app is worse than both. */
  it('does not throw when the SDK cannot start', async () => {
    vi.mocked(posthog.init).mockImplementationOnce(() => {
      throw new Error('blocked');
    });

    await expect(installPosthog(CONFIG)).resolves.toBeUndefined();
  });
});

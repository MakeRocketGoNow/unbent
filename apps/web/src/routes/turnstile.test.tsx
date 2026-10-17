import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@unbent/shared';
import { TurnstilePage } from './turnstile.js';
import * as api from '../notes-api.js';
import type { TurnstileOptions } from '../turnstile.js';

// No network in a unit test: the config is what each case says it is.
vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  getConfig: vi.fn(),
}));

/** What the app would hear, decoded the way the app decodes it. */
function listen(): Array<Record<string, unknown>> {
  const heard: Array<Record<string, unknown>> = [];
  window.UnbentApp = { postMessage: (json) => heard.push(JSON.parse(json)) };
  return heard;
}

function harness(config: Partial<AppConfig>) {
  vi.mocked(api.getConfig).mockResolvedValue({ providers: ['email-otp'], ...config });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TurnstilePage />
    </QueryClientProvider>,
  );
}

/**
 * The page the apps load off screen for a token (MAK-243). Cloudflare's script never loads
 * in a test, so `window.turnstile` stands in for what it leaves on the page.
 */
describe('the Turnstile page', () => {
  let widgets: TurnstileOptions[];

  beforeEach(() => {
    widgets = [];
    window.turnstile = {
      render: (_el, options) => {
        widgets.push(options);
        return '0';
      },
      reset: () => {},
      remove: () => {},
    };
  });
  afterEach(() => {
    cleanup();
    delete window.turnstile;
    delete window.UnbentApp;
  });

  it('draws the widget from the instance\'s site key and hands the app the token', async () => {
    const heard = listen();
    harness({ turnstile: { siteKey: '1x00' } });
    await waitFor(() => expect(widgets).toHaveLength(1));
    expect(widgets[0]!.sitekey).toBe('1x00');

    act(() => widgets[0]!['before-interactive-callback']?.());
    act(() => widgets[0]!.callback('tok-1'));
    expect(heard).toEqual([{ type: 'turnstile-interactive' }, { type: 'turnstile', token: 'tok-1' }]);
    expect(screen.getByText('Token minted.')).toBeTruthy();
  });

  it('tells the app when the widget could not run', async () => {
    const heard = listen();
    harness({ turnstile: { siteKey: '1x00' } });
    await waitFor(() => expect(widgets).toHaveLength(1));
    act(() => widgets[0]!['error-callback']?.('300030'));
    expect(heard).toEqual([{ type: 'turnstile-error', message: 'The widget could not run.' }]);
  });

  it('tells the app when the instance asks for no token', async () => {
    const heard = listen();
    harness({});
    await waitFor(() => expect(heard).toEqual([{ type: 'turnstile-error', message: 'This instance asks for no token.' }]));
    expect(widgets).toHaveLength(0);
  });
});

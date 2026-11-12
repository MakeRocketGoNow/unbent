import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { AppConfig } from '@unbent/shared';
import { keys } from '../queries.js';
import { markdownKeymap } from '../editor/markdown-commands.js';
import { FORMATS, HelpPage } from './HelpPage.js';

const OPERATOR = { name: 'Acme Notes', email: 'help@example.com', host: 'notes.example.com' };

function harness(config: Partial<AppConfig> = {}) {
  const rootRoute = createRootRoute({ component: () => <HelpPage build={null} /> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/help'] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.config(), { providers: ['password'], ...config });
  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

/** The help page (MAK-116): it has to answer "how do I make a table" on the page itself. */
describe('HelpPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('says what the table button writes', async () => {
    const { findByRole } = harness();
    const row = (await findByRole('rowheader', { name: 'Table' })).closest('tr')!;
    expect(row.textContent).toContain('| a | b |');
  });

  it('writes keys as this keyboard does: Ctrl off a Mac', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'Win32', userAgent: 'Windows' });
    const { findByRole } = harness();
    const row = (await findByRole('rowheader', { name: 'Strikethrough' })).closest('tr')!;
    expect(row.textContent).toContain('Ctrl+Shift+X');
  });

  it('writes the same keys with Apple\'s symbols on a Mac', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' });
    const { findByRole } = harness();
    const row = (await findByRole('rowheader', { name: 'Strikethrough' })).closest('tr')!;
    expect(row.textContent).toContain('⌘⇧X');
  });

  /* A key rebound in the editor and not here would leave the page naming a dead key. */
  it('names only keys the editor binds', () => {
    const bound = new Set(markdownKeymap.map((b) => b.key));
    const spelled = (parts: string[]) =>
      parts.map((p, i) => (i === parts.length - 1 ? p.toLowerCase() : p[0]!.toUpperCase() + p.slice(1))).join('-');
    for (const row of FORMATS) {
      if (row.shortcut) expect(bound, row.name).toContain(spelled(row.shortcut));
    }
  });

  it('points at the support page where the instance has one', async () => {
    const { findByText } = harness({ operator: OPERATOR, frontPage: true });
    expect((await findByText('Support')).getAttribute('href')).toBe('/support');
  });

  it('gives the address where there is no support page', async () => {
    const { findByText } = harness({ operator: OPERATOR });
    expect((await findByText('help@example.com')).getAttribute('href')).toBe('mailto:help@example.com');
  });

  /* Nobody named and no repository to send feedback to: nothing to point at, so no panel. */
  it('leaves out the last panel when there is nowhere to send anyone', async () => {
    const { findByText, queryByText } = harness();
    await findByText('Formatting');
    expect(queryByText('Something else')).toBeNull();
  });
});

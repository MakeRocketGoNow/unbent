import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { ApiError } from '../notes-api.js';

const agreeToLegal = vi.fn<(version: string) => Promise<void>>();
const refreshSession = vi.fn(async () => null);

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  agreeToLegal: (version: string) => agreeToLegal(version),
}));
vi.mock('../auth-client.js', () => ({ refreshSession: () => refreshSession() }));

const { LegalAgreement, needsAgreement } = await import('./LegalAgreement.js');

const LEGAL = { privacy: '/privacy', terms: '/terms', version: '2026-10-09' };

/**
 * Who is asked (MAK-209). Every case here is someone who would otherwise be let into the
 * app without agreeing, or kept out of it after they had.
 */
describe('needsAgreement', () => {
  it('asks an account that has never agreed', () => {
    expect(needsAgreement(LEGAL, null, '/notes')).toBe(true);
    expect(needsAgreement(LEGAL, undefined, '/notes')).toBe(true);
  });

  it('asks again when the version has moved', () => {
    expect(needsAgreement(LEGAL, '2026-01-01', '/notes')).toBe(true);
  });

  it('lets through an account that agreed to this version', () => {
    expect(needsAgreement(LEGAL, '2026-10-09', '/notes')).toBe(false);
  });

  /** Nothing published, or an instance older than the agreement step: nothing to agree to. */
  it('never asks where there is nothing to agree to', () => {
    expect(needsAgreement(undefined, null, '/notes')).toBe(false);
    expect(needsAgreement({ privacy: '/privacy', terms: '/terms' }, null, '/notes')).toBe(false);
  });

  /** What the terms promise someone who does not agree: their notes, and a way to leave. */
  it('keeps export and account deletion open without agreeing', () => {
    expect(needsAgreement(LEGAL, null, '/settings/export')).toBe(false);
    expect(needsAgreement(LEGAL, null, '/settings/maintenance/')).toBe(false);
    expect(needsAgreement(LEGAL, null, '/settings/security')).toBe(true);
  });
});

function harness(props: { agreed: string | null; change?: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSignOut = vi.fn();
  const rootRoute = createRootRoute({
    component: () => (
      <LegalAgreement legal={{ ...LEGAL, change: props.change }} agreed={props.agreed} onSignOut={onSignOut} />
    ),
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/notes'] }) });
  const view = render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return { ...view, onSignOut };
}

describe('LegalAgreement', () => {
  beforeEach(() => {
    agreeToLegal.mockReset();
    refreshSession.mockClear();
  });
  afterEach(cleanup);

  it('links both documents and records the version shown', async () => {
    agreeToLegal.mockResolvedValue();
    const { findByRole, getByRole } = harness({ agreed: null });
    expect(await findByRole('heading', { name: 'Before you start' })).toBeTruthy();
    expect(getByRole('link', { name: 'Terms of Service' }).getAttribute('href')).toBe('/terms');
    expect(getByRole('link', { name: 'Privacy Policy' }).getAttribute('href')).toBe('/privacy');

    fireEvent.click(getByRole('button', { name: 'Agree and continue' }));
    await waitFor(() => expect(refreshSession).toHaveBeenCalled());
    expect(agreeToLegal).toHaveBeenCalledWith('2026-10-09');
  });

  it('says the documents changed, and what changed, to someone who agreed before', async () => {
    const { findByRole, getByText } = harness({ agreed: '2026-01-01', change: 'Backups are now kept for 90 days.' });
    expect(await findByRole('heading', { name: 'We’ve updated our terms' })).toBeTruthy();
    expect(getByText('Backups are now kept for 90 days.')).toBeTruthy();
  });

  /** Agreeing to documents this page never showed is the one outcome that must not happen. */
  it('records nothing and says so when the terms changed under the page', async () => {
    agreeToLegal.mockRejectedValue(new ApiError(409, 'changed'));
    const { findByRole, findByText } = harness({ agreed: null });
    fireEvent.click(await findByRole('button', { name: 'Agree and continue' }));
    expect(await findByText(/changed while this page was open/)).toBeTruthy();
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('always offers a way out', async () => {
    const { findByRole, getByRole, onSignOut } = harness({ agreed: null });
    fireEvent.click(await findByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalled();
    expect(getByRole('link', { name: 'export your notes' }).getAttribute('href')).toBe('/settings/export');
    expect(getByRole('link', { name: 'delete your account' }).getAttribute('href')).toBe('/settings/maintenance');
  });
});

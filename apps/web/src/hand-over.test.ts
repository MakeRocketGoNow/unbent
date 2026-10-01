import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { handOver } from './hand-over.js';
import { claimImportFor } from './import-run.js';

vi.mock('./import-run.js', () => ({ claimImportFor: vi.fn() }));

/**
 * What the root route's guard hands over on every navigation. The rules are the ones the
 * guard depends on and nothing else would notice breaking: a new person gets a clean
 * cache and a run that is not the last person's, and a public page is nobody's sign-out.
 */
describe('handOver', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('claims the import run for the person signed in', () => {
    handOver(new QueryClient(), 'user-a');
    expect(claimImportFor).toHaveBeenCalledWith('user-a');
  });

  /*
   * The guard answers nobody for a public page even when someone is signed in. Claiming
   * nobody is a sign-out, and would throw a running import away because `/privacy` was
   * opened partway through it.
   */
  it('leaves the import run alone on a page that has no session', () => {
    handOver(new QueryClient(), undefined);
    expect(claimImportFor).not.toHaveBeenCalled();
  });

  it('empties the cache for a different person, and keeps it for the same one', () => {
    const queryClient = new QueryClient();
    handOver(queryClient, 'user-a');
    queryClient.setQueryData(['notes'], ['a note']);

    handOver(queryClient, 'user-a');
    expect(queryClient.getQueryData(['notes'])).toEqual(['a note']);

    handOver(queryClient, undefined);
    expect(queryClient.getQueryData(['notes'])).toEqual(['a note']);

    handOver(queryClient, 'user-b');
    expect(queryClient.getQueryData(['notes'])).toBeUndefined();
  });
});

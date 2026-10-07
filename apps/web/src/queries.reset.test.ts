import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { installLibraryQueries, keys } from './queries.js';
import { notifyLibraryReset } from './store/library.js';

/**
 * A reset drops the library's cached answers that nothing is looking at, and leaves the
 * watched ones to the walk's change notifications. The case: a note opened, edited and
 * closed; the account wound back; the note opened again. Its cached answer was from
 * before the wind-back, the route loader served it as cached, the workspace seeded from
 * it and then refused the older truth as a stale row (MAK-196).
 */
describe('installLibraryQueries on a reset', () => {
  const client = new QueryClient();
  const stop = installLibraryQueries(client);
  afterEach(() => stop());

  it('drops unwatched library answers and keeps watched ones', () => {
    client.setQueryData(keys.note('closed'), { id: 'closed', title: 'from before the wind-back' });
    client.setQueryData(keys.note('open'), { id: 'open', title: 'on screen' });
    client.setQueryData(keys.config(), { providers: [] });
    const observer = new QueryObserver(client, { queryKey: keys.note('open'), queryFn: () => ({ id: 'open', title: 'on screen' }) });
    const unsubscribe = observer.subscribe(() => {});

    notifyLibraryReset();

    expect(client.getQueryData(keys.note('closed'))).toBeUndefined();
    expect(client.getQueryData(keys.note('open'))).toEqual({ id: 'open', title: 'on screen' });
    // Not a library root: the instance's config is the server's answer, not a row.
    expect(client.getQueryData(keys.config())).toEqual({ providers: [] });
    unsubscribe();
  });
});

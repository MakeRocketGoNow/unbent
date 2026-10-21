import { SHELL_META_CACHE, commitOf, isShellCache, staleShellCaches } from './routes.js';

/**
 * Which builds' shells the worker keeps, and the record that decides it: the deploy's
 * tidy (`tidy`), what a page says it runs (`running`), and what a fresh install is
 * (`installed`). See `tidyShellCaches` in `sw.ts` for why each build an open page runs
 * is kept.
 *
 * Apart from `sw.ts`, and given the cache storage and the clients rather than reaching
 * for the worker's globals, so the whole of it can be tried against fakes: the pure half
 * (`staleShellCaches`) was tested, and the half that reads the records and matches them
 * to caches was not, while a mismatch there (a short commit on one side, say) would
 * silently delete every open tab's build on the next deploy.
 *
 * Kept cheap, because the tidy runs inside `activate`, and the requests of the pages it
 * claims wait for that: the open tabs are listed once (`matchAll`), not looked up record
 * by record; a page's record is written with the records of closed pages dropped, so the
 * record never outgrows the open tabs; and each shell's commit is written down when it
 * is installed (`/commit/<cache>`), so the tidy reads one small entry per cache instead
 * of listing a few hundred keys to find its page. A shell from before that record is
 * still read the slow way, once.
 */

export interface ShellCaches {
  open(name: string): Promise<Pick<Cache, 'match' | 'put' | 'delete' | 'keys'>>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

export interface ShellClients {
  matchAll(options: { includeUncontrolled: boolean; type: 'window' }): Promise<ReadonlyArray<{ id: string }>>;
}

const PREVIOUS_KEY = '/previous';
const RUNNING_PREFIX = '/running/';
const COMMIT_PREFIX = '/commit/';

export function createShellKeeper(opts: { caches: ShellCaches; clients: ShellClients; current: string }) {
  const { caches, clients, current } = opts;
  const meta = () => caches.open(SHELL_META_CACHE);
  const text = (response: Response | undefined) => response?.text().catch(() => undefined) ?? Promise.resolve(undefined);
  const live = async () => new Set((await clients.matchAll({ includeUncontrolled: true, type: 'window' })).map((client) => client.id));

  /** The records of open pages, by client id, with the records of closed ones dropped. */
  async function runningRecords(): Promise<Map<string, Request>> {
    const store = await meta();
    const open = await live();
    const records = new Map<string, Request>();
    for (const request of await store.keys()) {
      const path = new URL(request.url).pathname;
      if (!path.startsWith(RUNNING_PREFIX)) continue;
      const id = decodeURIComponent(path.slice(RUNNING_PREFIX.length));
      if (open.has(id)) records.set(id, request);
      else await store.delete(request);
    }
    return records;
  }

  /**
   * The commit a shell cache was built from: as written down, or read from its page and
   * written down then, so a shell from before the record, or one refilled after the
   * caches were cleared (which no install records), is read the slow way once and not at
   * every tidy that keeps it.
   */
  async function commitOfCache(name: string): Promise<string | null> {
    const store = await meta();
    const key = `${COMMIT_PREFIX}${encodeURIComponent(name)}`;
    const recorded = await text(await store.match(key));
    if (recorded) return recorded;
    const cache = await caches.open(name);
    const page = (await cache.keys()).find((request) => new URL(request.url).pathname === '/index.html');
    const commit = commitOf((page && (await text(await cache.match(page)))) ?? '');
    if (commit) await store.put(key, new Response(commit));
    return commit;
  }

  return {
    /** Writes down this build's commit once its shell is whole. */
    async installed(): Promise<void> {
      await commitOfCache(current);
    },

    /** Writes down that a page is running the build of `commit`. */
    async running(clientId: string, commit: string): Promise<void> {
      await runningRecords();
      await (await meta()).put(`${RUNNING_PREFIX}${encodeURIComponent(clientId)}`, new Response(commit));
    },

    /** Deletes the shells no open page needs, once this worker is in charge (`staleShellCaches`). */
    async tidy(): Promise<void> {
      const store = await meta();
      const before = await text(await store.match(PREVIOUS_KEY));
      const previous = before && before !== current ? before : undefined;
      const commits = new Set<string>();
      for (const request of (await runningRecords()).values()) {
        const commit = await text(await store.match(request));
        if (commit) commits.add(commit);
      }
      const names = await caches.keys();
      const running = new Set<string>();
      for (const name of names) {
        if (!isShellCache(name) || name === current) continue;
        const commit = await commitOfCache(name);
        if (commit && commits.has(commit)) running.add(name);
      }
      for (const name of staleShellCaches(names, { current, previous, running })) {
        await caches.delete(name);
        await store.delete(`${COMMIT_PREFIX}${encodeURIComponent(name)}`);
      }
      await store.put(PREVIOUS_KEY, new Response(current));
    },
  };
}

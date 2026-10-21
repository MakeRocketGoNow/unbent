// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SHELL_META_CACHE, shellCacheName } from './routes.js';
import { createShellKeeper, type ShellCaches } from './tidy.js';

/**
 * Cache storage as the worker sees it, in memory: caches by name, each a map of address
 * to body. Enough of the Cache API for the keeper, which is all it is given.
 */
function fakeCaches() {
  const stores = new Map<string, Map<string, string>>();
  const key = (request: RequestInfo | URL) => new URL(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url, 'https://unbent.app').href;
  const caches: ShellCaches = {
    async open(name) {
      let store = stores.get(name);
      if (!store) stores.set(name, (store = new Map()));
      const entries = store;
      return {
        async match(request: RequestInfo | URL) {
          const body = entries.get(key(request));
          return body === undefined ? undefined : new Response(body);
        },
        async put(request: RequestInfo | URL, response: Response) {
          entries.set(key(request), await response.text());
        },
        async delete(request: RequestInfo | URL) {
          return entries.delete(key(request));
        },
        async keys() {
          return [...entries.keys()].map((url) => new Request(url));
        },
      } as unknown as Cache;
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
  /** A build's shell, as the install fills it: its page under a revisioned key, and a chunk. */
  const shell = async (commit: string) => {
    const name = shellCacheName(`rev-${commit}`);
    const cache = await caches.open(name);
    await cache.put(`/index.html?__WB_REVISION__=rev-${commit}`, new Response(`<head><meta name="unbent-commit" content="${commit}"></head>`));
    await cache.put(`/assets/app-${commit}.js`, new Response('js'));
    return name;
  };
  const shells = () => [...stores.keys()].filter((name) => name !== SHELL_META_CACHE).sort();
  return { caches, shell, shells };
}

function fakeClients(...ids: string[]) {
  const open = new Set(ids);
  return { open, clients: { matchAll: async () => [...open].map((id) => ({ id })) } };
}

/** A deploy: the new build's shell installed, then its worker's tidy. */
async function deploy(fake: ReturnType<typeof fakeCaches>, clients: ReturnType<typeof fakeClients>['clients'], commit: string) {
  const current = await fake.shell(commit);
  const keeper = createShellKeeper({ caches: fake.caches, clients, current });
  await keeper.installed();
  await keeper.tidy();
  return keeper;
}

describe('createShellKeeper', () => {
  /* A shell refilled after the caches were cleared has no install to record it; the first tidy that reads its page does. */
  it('writes down the commit of a shell it had to read, so the next tidy does not read it again', async () => {
    const fake = fakeCaches();
    const { clients } = fakeClients('tab-1');
    const older = await fake.shell('aaaa');
    const keeper = createShellKeeper({ caches: fake.caches, clients, current: await fake.shell('bbbb') });
    await keeper.installed();
    await keeper.running('tab-1', 'aaaa');
    const meta = await fake.caches.open(SHELL_META_CACHE);
    const recorded = async () => (await meta.match(`/commit/${encodeURIComponent(older)}`))?.text();
    await keeper.tidy();
    expect(await recorded()).toBe('aaaa');
  });

  it('keeps every build an open page runs, across deploys, and lets it go once the page closes', async () => {
    const fake = fakeCaches();
    const { open, clients } = fakeClients('tab-1');
    const first = await deploy(fake, clients, 'aaaa');
    await first.running('tab-1', 'aaaa');
    await deploy(fake, clients, 'bbbb');
    await deploy(fake, clients, 'cccc');
    expect(fake.shells()).toEqual([shellCacheName('rev-aaaa'), shellCacheName('rev-bbbb'), shellCacheName('rev-cccc')]);

    open.delete('tab-1');
    await deploy(fake, clients, 'dddd');
    expect(fake.shells()).toEqual([shellCacheName('rev-cccc'), shellCacheName('rev-dddd')]);
  });

  /* A page loaded in the moments before a deploy may not have said yet, and one from before pages said never will. */
  it('keeps the previous build with no record, and no older one', async () => {
    const fake = fakeCaches();
    const { clients } = fakeClients();
    await deploy(fake, clients, 'aaaa');
    await deploy(fake, clients, 'bbbb');
    await deploy(fake, clients, 'cccc');
    expect(fake.shells()).toEqual([shellCacheName('rev-bbbb'), shellCacheName('rev-cccc')]);
  });

  it('matches a shell from before commits were written down by the commit its own page names', async () => {
    const fake = fakeCaches();
    const { clients } = fakeClients('tab-1');
    const old = await fake.shell('aaaa');
    const keeper = createShellKeeper({ caches: fake.caches, clients, current: old });
    await keeper.running('tab-1', 'aaaa');
    await deploy(fake, clients, 'bbbb');
    await deploy(fake, clients, 'cccc');
    expect(fake.shells()).toContain(old);
  });

  /* The record never outgrows the open tabs: it is pruned whenever a page says what it runs. */
  it('drops the records of closed pages when a page says what it runs', async () => {
    const fake = fakeCaches();
    const { open, clients } = fakeClients('tab-1', 'tab-2');
    const keeper = await deploy(fake, clients, 'aaaa');
    await keeper.running('tab-1', 'aaaa');
    await keeper.running('tab-2', 'aaaa');
    open.delete('tab-1');
    await keeper.running('tab-2', 'aaaa');
    const meta = await fake.caches.open(SHELL_META_CACHE);
    const running = (await meta.keys()).map((request) => new URL(request.url).pathname).filter((path) => path.startsWith('/running/'));
    expect(running).toEqual(['/running/tab-2']);
  });
});

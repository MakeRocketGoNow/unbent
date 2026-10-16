import { FILES_CACHE } from './routes.js';

/**
 * How much of what someone merely opened this device keeps, and what goes first.
 *
 * The files cache (`files-v1`) fills as files are looked at. It had a count and an age,
 * from Workbox's expiration plugin; a count is the wrong unit for an archive of scans,
 * where a hundred and fifty files is fifteen megabytes or two gigabytes depending on the
 * scanner. So the budget is in bytes as well, and oldest-opened goes first. Opened, not
 * stored: a manual read every week should outlast a receipt looked at once.
 *
 * That order is why this is ours and not the plugin's. Workbox keeps its timestamps in a
 * database of its own with no size beside them, and Cache Storage orders its keys by when
 * they were put, not used. So the cache carries a small index of its own (address, size,
 * last opened) as one more entry in it, under an address no route serves. In the cache
 * rather than in IndexedDB so that emptying the cache, which the page does on every
 * account change (`offline-cache.ts`), takes the index with it; and reconciled against
 * the cache's real keys on every pass, so an entry either side lost is noticed.
 *
 * Kept notebooks and waiting uploads are not counted here. They are in the account's own
 * directory (`store/files.ts`), by choice, and stay until the choice is taken back.
 *
 * The rule is a pure function with a table of cases; the plumbing around it is below.
 */
export interface FilesBudget {
  maxBytes: number;
  maxEntries: number;
  maxAgeMs: number;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Five hundred megabytes, five hundred files, a month. A few hundred scanned PDFs at the
 * sizes the real archive has; decided with the numbers on the table (MAK-141), where the
 * alternatives were half and double. A file over twenty megabytes is never kept at all
 * (`MAX_KEPT_FILE` in `sw.ts`), so one enormous scan cannot be the whole budget.
 */
export const FILES_BUDGET: FilesBudget = { maxBytes: 500 * 1024 * 1024, maxEntries: 500, maxAgeMs: 30 * DAY };

/** One kept file: how big, and when it was last opened. */
export interface Opened {
  size: number;
  used: number;
}

export type Index = Record<string, Opened>;

/**
 * The addresses to drop so that what is left fits: everything not opened within the age,
 * then oldest-opened first until both the count and the bytes are within budget.
 */
export function evictions(index: Index, now: number, budget: FilesBudget = FILES_BUDGET): string[] {
  const out: string[] = [];
  const live: Array<[string, Opened]> = [];
  for (const entry of Object.entries(index)) {
    if (now - entry[1].used > budget.maxAgeMs) out.push(entry[0]);
    else live.push(entry);
  }
  live.sort((a, b) => a[1].used - b[1].used);
  let bytes = live.reduce((sum, [, e]) => sum + e.size, 0);
  let count = live.length;
  for (const [url, entry] of live) {
    if (bytes <= budget.maxBytes && count <= budget.maxEntries) break;
    out.push(url);
    bytes -= entry.size;
    count -= 1;
  }
  return out;
}

/** The index's own address in the cache. Under `/api/` so no page load is ever answered with it, and nothing routes there. */
export const INDEX_URL = '/api/__files-index';

const isIndex = (url: string) => new URL(url, 'https://x').pathname === INDEX_URL;

async function readIndex(cache: Cache): Promise<Index> {
  try {
    const res = await cache.match(INDEX_URL);
    return res ? ((await res.json()) as Index) : {};
  } catch {
    return {};
  }
}

/**
 * What the cache holds, as the page reads it for Settings: how many files and how many
 * bytes. From the index alone, so asking costs one small read however full the cache is.
 */
export async function openedFilesUsage(): Promise<{ files: number; bytes: number }> {
  if (typeof caches === 'undefined') return { files: 0, bytes: 0 };
  try {
    const entries = Object.values(await readIndex(await caches.open(FILES_CACHE)));
    return { files: entries.length, bytes: entries.reduce((sum, e) => sum + e.size, 0) };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

/**
 * The index held by a running worker, and the passes that keep the cache within budget.
 *
 * Every change goes through one chain, so two pictures loading at once cannot each read
 * the index, add themselves, and write the other out. A worker is stopped whenever the
 * browser likes; what is lost then is at most a minute of "last opened" (see `touch`),
 * and the next pass reconciles the rest.
 */
export function createFilesLedger(budget: FilesBudget = FILES_BUDGET, now: () => number = Date.now) {
  let chain: Promise<void> = Promise.resolve();
  const run = (fn: (cache: Cache, index: Index) => Promise<boolean>) => {
    chain = chain
      .then(async () => {
        const cache = await caches.open(FILES_CACHE);
        const index = await readIndex(cache);
        if (await fn(cache, index)) await cache.put(INDEX_URL, new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } }));
      })
      .catch(() => {});
    return chain;
  };

  /** Brings the index in line with the cache, then drops what does not fit. */
  const enforce = async (cache: Cache, index: Index) => {
    const held = new Set<string>();
    for (const request of await cache.keys()) {
      if (isIndex(request.url)) continue;
      held.add(request.url);
      if (index[request.url]) continue;
      // Put there by something that did not say so: the page, after an upload it made
      // offline went through. Its size is in its headers; it was opened now.
      const res = await cache.match(request);
      index[request.url] = { size: Number(res?.headers.get('Content-Length') ?? 0), used: now() };
    }
    for (const url of Object.keys(index)) if (!held.has(url)) delete index[url];
    for (const url of evictions(index, now(), budget)) {
      await cache.delete(url);
      delete index[url];
    }
  };

  return {
    /** A file was just stored: note it, and make room. */
    stored: (url: string, size: number) =>
      run(async (cache, index) => {
        index[url] = { size, used: now() };
        await enforce(cache, index);
        return true;
      }),
    /**
     * A kept file was opened again. Written at most once a minute per file: the order
     * that matters is over days, and a note with twenty pictures should not rewrite the
     * index twenty times to say they were all opened this second.
     */
    touch: (url: string) =>
      run(async (_cache, index) => {
        const entry = index[url];
        if (!entry || now() - entry.used < 60_000) return false;
        entry.used = now();
        return true;
      }),
    /** A pass with nothing new: what the worker runs when it starts. */
    sweep: () =>
      run(async (cache, index) => {
        await enforce(cache, index);
        return true;
      }),
  };
}

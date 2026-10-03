import { ApiError, isOfflineError, request } from '../notes-api.js';
import { offlineNow, subscribeConnectivity } from '../connectivity.js';
import type { LocalAttachment, LocalNote } from './collections.js';
import { clearShelf, filesSupported, listShelf, readKeptNotebooks, removeFile, shelfName, writeFile, writeKeptNotebooks, type ShelvedFile } from './files.js';

/**
 * Whole notebooks kept on the device: Evernote's "offline notebooks", for the PDF someone
 * opens on a plane.
 *
 * The rows of every notebook are already local. The bytes are the bulk of an archive —
 * gigabytes against the database's megabytes — so they cannot all be here, and which ones
 * are is a choice made per notebook, per device, with the size stated first. A kept
 * notebook's files are fetched to the account's `kept` shelf (`files.ts`), where the
 * service worker finds them by address; a file that arrives in one later, through the
 * feed, is fetched when the feed delivers its row; one that leaves — deleted, its note
 * trashed or moved out — is removed. So the shelf is always what `plan` says it should
 * be, and `plan` is a pure function of the library and the list of kept notebooks.
 *
 * The decision of what to fetch and what to drop is the part with cases, so it is apart
 * from the part that does the fetching, and tested as a table.
 */

/** What the keeper reads of the library. */
export interface KeepSnapshot {
  notes: Iterable<Pick<LocalNote, 'id' | 'notebookId' | 'deletedAt'>>;
  attachments: Iterable<Pick<LocalAttachment, 'noteId' | 'filename' | 'size' | 'pending'>>;
}

export interface WantedFile {
  noteId: string;
  filename: string;
  size: number;
}

/**
 * A notebook's files as they would be kept: every file of every live note filed in it.
 * Not a trashed note's — the trash is on its way out, and keeping its scans would be
 * storage spent on what was thrown away. Not a file still waiting to upload — its bytes
 * are on the `pending` shelf already, and the server has nothing to fetch.
 *
 * By `notebookId`, the feed's own key. A note filed here a moment ago into a notebook the
 * server has not made yet carries a name and no id (`LocalNote`), and is picked up when
 * the feed brings the id.
 */
export function filesOf(snapshot: KeepSnapshot, notebookIds: ReadonlySet<string>): WantedFile[] {
  const inside = new Set<string>();
  for (const n of snapshot.notes) if (n.deletedAt === undefined && n.notebookId != null && notebookIds.has(n.notebookId)) inside.add(n.id);
  const out: WantedFile[] = [];
  for (const a of snapshot.attachments) if (!a.pending && inside.has(a.noteId)) out.push({ noteId: a.noteId, filename: a.filename, size: a.size });
  return out;
}

export interface KeepPlan {
  /** Files a kept notebook has that the shelf does not, smallest first. */
  fetch: WantedFile[];
  /** Files on the shelf no kept notebook has any more. */
  remove: ShelvedFile[];
  /** Everything the kept notebooks hold, fetched or not. */
  wanted: { files: number; bytes: number };
  /** What of that is on the shelf now. */
  have: { files: number; bytes: number };
}

/**
 * What to fetch and what to drop so the shelf holds exactly the kept notebooks' files.
 *
 * A file is "on the shelf" when one of its name and size is: attachments are immutable,
 * but a name can be reused — delete `scan.pdf`, add another — and the size is what tells
 * the new one from the old without reading either. Smallest first, so that with a
 * connection that lasts a minute the shelf gains forty receipts rather than a third of
 * one manual.
 */
export function plan(snapshot: KeepSnapshot, kept: ReadonlySet<string>, shelf: ShelvedFile[]): KeepPlan {
  const wanted = filesOf(snapshot, kept);
  const key = (noteId: string, name: string) => `${noteId}/${name}`;
  const on = new Map(shelf.map((f) => [key(f.noteId, f.name), f]));
  const fetch: WantedFile[] = [];
  const claimed = new Set<string>();
  const have = { files: 0, bytes: 0 };
  for (const w of wanted) {
    const k = key(w.noteId, shelfName(w.filename));
    if (on.get(k)?.size === w.size) {
      claimed.add(k);
      have.files += 1;
      have.bytes += w.size;
    } else {
      fetch.push(w);
    }
  }
  fetch.sort((a, b) => a.size - b.size);
  return {
    fetch,
    // A file of the right name and the wrong size is replaced by the fetch; it is not removed first.
    remove: shelf.filter((f) => !claimed.has(key(f.noteId, f.name)) && !fetch.some((w) => key(w.noteId, shelfName(w.filename)) === key(f.noteId, f.name))),
    wanted: { files: wanted.length, bytes: wanted.reduce((sum, w) => sum + w.size, 0) },
    have,
  };
}

export interface KeepStatus {
  /** Whether this browser can keep files at all (`filesSupported`). */
  supported: boolean;
  /** The notebooks kept on this device, by id. */
  kept: ReadonlySet<string>;
  /**
   * Whether the totals below have been counted yet. They are zero until the first pass,
   * which waits for the library to be whole; a page that read them before then would say
   * "all 0 files are on this device" about a notebook of two hundred.
   */
  counted: boolean;
  wanted: { files: number; bytes: number };
  have: { files: number; bytes: number };
  /** A pass is fetching now. */
  fetching: boolean;
  /** Why the last pass stopped short, when it was not for want of a connection. */
  problem: string | null;
}

export interface Keeper {
  status: () => KeepStatus;
  subscribe: (listener: (status: KeepStatus) => void) => () => void;
  /** Starts keeping a notebook: recorded first, fetched after. */
  keep: (notebookId: string) => Promise<void>;
  /** Stops keeping one; its files leave the shelf on the pass that follows. */
  release: (notebookId: string) => Promise<void>;
  /** Stops keeping every notebook and empties the shelf. */
  releaseAll: () => Promise<void>;
  /** Asks for a pass: the library moved, the connection came back. */
  nudge: () => void;
  stop: () => void;
}

export interface KeeperOptions {
  userId: string;
  snapshot: () => KeepSnapshot;
  /**
   * Whether the library holds the whole account. A pass during the first copy, or after a
   * `reset` has emptied the collections, would see no notes in a kept notebook and drop a
   * gigabyte it would then fetch again.
   */
  settled: () => boolean;
  /**
   * Whether this tab is the one that does the account's background work — the tab that
   * holds the outbox. Two tabs fetching the same notebook would write the same files
   * twice over.
   */
  leading: () => boolean;
}

const url = (f: WantedFile) => `/api/notes/${encodeURIComponent(f.noteId)}/files/${encodeURIComponent(f.filename)}`;

/** A share of what the browser says is free that a pass will not go below, so the note database always has room to write. */
const HEADROOM = 50 * 1024 * 1024;

export function createKeeper(opts: KeeperOptions): Keeper {
  const supported = filesSupported();
  let kept = new Set<string>();
  let state: KeepStatus = { supported, kept, counted: false, wanted: { files: 0, bytes: 0 }, have: { files: 0, bytes: 0 }, fetching: false, problem: null };
  const listeners = new Set<(s: KeepStatus) => void>();
  const set = (next: Partial<KeepStatus>) => {
    state = { ...state, ...next };
    listeners.forEach((l) => l(state));
  };

  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const loaded = supported
    ? readKeptNotebooks(opts.userId).then((ids) => {
        kept = new Set(ids);
        set({ kept });
      })
    : Promise.resolve();

  /**
   * One pass: bring the shelf to what `plan` says, removals first so their room is free
   * for the fetches. Stops at the first file the network does not answer — the next
   * connection starts another pass, and what was fetched stays fetched.
   *
   * Fetched through `request`, so a lost connection is heard by the connectivity store
   * like any other, and unmarked: `X-Unbent-View` would put every file of the notebook in
   * the cache of opened files as well, and push out what someone actually opened.
   */
  async function pass(): Promise<void> {
    await loaded;
    if (stopped || !supported || !opts.settled()) return;
    const shelf = await listShelf(opts.userId, 'kept');
    const todo = plan(opts.snapshot(), kept, shelf);
    set({ counted: true, wanted: todo.wanted, have: todo.have });
    if (!opts.leading()) return;
    for (const f of todo.remove) await removeFile(opts.userId, 'kept', f.noteId, f.name).catch(() => {});
    if (todo.fetch.length === 0 || offlineNow()) {
      set({ fetching: false, problem: null });
      return;
    }
    set({ fetching: true, problem: null });
    const have = { ...todo.have };
    try {
      for (const f of todo.fetch) {
        if (stopped || again) return;
        const room = await navigator.storage.estimate?.().catch(() => null);
        if (room?.quota !== undefined && room.usage !== undefined && f.size > room.quota - room.usage - HEADROOM) {
          set({ problem: 'This device is out of room, so some files are not kept yet.' });
          return;
        }
        let res: Response;
        try {
          res = await request(url(f));
        } catch (err) {
          if (isOfflineError(err)) return;
          throw err;
        }
        // Gone since the plan was made: deleted on another device, and the feed will say so.
        if (res.status === 404) continue;
        if (!res.ok || !res.body) throw new ApiError(res.status, `${f.filename} answered ${res.status}`);
        await writeFile(opts.userId, 'kept', f.noteId, f.filename, res.body);
        have.files += 1;
        have.bytes += f.size;
        set({ have: { ...have } });
      }
    } catch (err) {
      set({ problem: `Some files could not be kept: ${(err as Error).message}` });
    } finally {
      set({ fetching: false });
    }
  }

  function run(): void {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = pass()
      .catch((err: unknown) => console.error('[keep] pass failed:', err))
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          run();
        }
      });
  }

  /**
   * A pass, soon. The library changes in bursts — a feed page is hundreds of rows, an
   * import thousands — and each change would otherwise list the shelf again.
   */
  function nudge(): void {
    if (stopped || !supported || timer) return;
    // The first count is not worth waiting for: a page is showing nothing until it lands.
    if (!state.counted) return run();
    timer = setTimeout(() => {
      timer = null;
      run();
    }, 1500);
  }

  const unsubscribe = subscribeConnectivity(() => {
    if (!offlineNow()) nudge();
  });
  void loaded.then(run);

  const save = async (next: Set<string>) => {
    await loaded;
    await writeKeptNotebooks(opts.userId, [...next]);
    kept = next;
    set({ kept });
    run();
  };

  return {
    status: () => state,
    subscribe: (l) => {
      listeners.add(l);
      l(state);
      return () => void listeners.delete(l);
    },
    keep: (id) => save(new Set([...kept, id])),
    release: (id) => save(new Set([...kept].filter((k) => k !== id))),
    releaseAll: async () => {
      await loaded;
      await writeKeptNotebooks(opts.userId, []);
      kept = new Set();
      // The whole shelf at once, rather than a pass removing it a file at a time.
      await clearShelf(opts.userId, 'kept');
      set({ kept, wanted: { files: 0, bytes: 0 }, have: { files: 0, bytes: 0 }, problem: null });
    },
    nudge,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    },
  };
}

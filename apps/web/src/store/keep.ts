import { ApiError, isOfflineError, request } from '../notes-api.js';
import { offlineNow, recheck, subscribeConnectivity } from '../connectivity.js';
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
  // A file of the right name and the wrong size is replaced by the fetch; it is not removed first.
  const replaced = new Set(fetch.map((w) => key(w.noteId, shelfName(w.filename))));
  return {
    fetch,
    remove: shelf.filter((f) => !claimed.has(key(f.noteId, f.name)) && !replaced.has(key(f.noteId, f.name))),
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
   * Whether the library holds the whole account: a walk of it has finished, whether or
   * not the latest pull did. A pass during the first copy, or after a `reset` has emptied
   * the collections, would see no notes in a kept notebook and drop a gigabyte it would
   * then fetch again — and would count "0 of 0", so nothing is counted then either.
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

/** A share of what the browser says is free that a pass will not go below, so the note database always has room to write. Also what the keep confirmation leaves out of "room", so it never confirms what a pass would then refuse. */
export const HEADROOM = 50 * 1024 * 1024;

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
  /** Downloads in a row that died part-way; see the catch in `pass`. */
  let cutOff = 0;
  /**
   * What is on the `kept` shelf, by note and name, as this keeper last knew it: read from
   * the disk on the first pass and after anything failed, and kept in step by the writes
   * and removals made here. Listing the shelf is a `getFile()` per file, and the library
   * changes in bursts — a feed page, an import, a rename — each of which asks for a pass;
   * on an archive-sized notebook that was thousands of file-system calls per burst to
   * learn what the keeper had written itself (review of #236).
   */
  let shelf: Map<string, ShelvedFile> | null = null;
  const at = (noteId: string, name: string) => `${noteId}/${name}`;
  /**
   * Set when a notebook is released, to stop the pass in hand: it is fetching files that
   * are no longer wanted. Nothing else stops one. A change to the library asks for
   * another pass after this one (`again`), and that pass fetches only what is still
   * missing — abandoning the fetch in hand on every nudge meant a busy feed could keep a
   * large file from ever finishing.
   */
  let halt = false;

  /**
   * Reads the list of kept notebooks from the device, at the start of every pass and
   * before every change to it. Throws when it cannot be read.
   *
   * Every time, not once: the list is the device's, and another tab of the same account
   * can change it. Only one tab fetches, and it is rarely the one someone pressed Keep
   * offline in; a keeper that read the list when it started never fetched a notebook kept
   * from the other tab, and went on believing in files another tab's release had removed
   * (review of #236). It is one small file. When it has changed, what this keeper
   * remembers of the shelf is dropped with it, and a pass in hand is stopped if a
   * notebook was released, as it is for a release made here.
   *
   * Until a read has succeeded the keeper knows nothing — not "nothing is kept" — and
   * does nothing: a pass over an empty list removes the whole shelf, and a `keep` would
   * write a list of one over the real one. After one has, a failed read leaves the last
   * list standing, and the pass that follows removes nothing on its word.
   */
  let known = !supported;
  async function read(): Promise<void> {
    if (!supported) return;
    const ids = await readKeptNotebooks(opts.userId);
    const same = known && ids.length === kept.size && ids.every((id) => kept.has(id));
    known = true;
    if (same) return;
    if ([...kept].some((id) => !ids.includes(id))) halt = true;
    kept = new Set(ids);
    shelf = null;
    set({ kept });
  }

  /**
   * How the tabs of one account tell each other: `list` when the kept list was changed,
   * so the tab that fetches starts on it now rather than at its next pass; `shelf` when
   * the fetching tab has put files on the shelf or taken them off, so a tab that is only
   * showing progress counts again. A convenience on top of reading the list every pass —
   * a browser without it is still right, a pass later.
   */
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`unbent-keep-${opts.userId}`);
  const tell = (what: 'list' | 'shelf') => {
    try {
      channel?.postMessage(what);
    } catch {
      // Closed under us; the next pass reads the disk anyway.
    }
  };
  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      if (stopped) return;
      if (event.data === 'list') void read().then(run, run);
      else if (!opts.leading()) run();
    };
  }
  /** When the other tabs were last told the shelf moved; a long pass says so every few seconds, not per file. */
  let told = 0;

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
    // Whether the list is the one on the device this moment. A pass may fetch on the word
    // of the last list read; it removes nothing unless this read succeeded.
    let fresh = true;
    try {
      await read();
    } catch {
      if (!known) {
        set({ problem: 'The list of kept notebooks could not be read. Nothing was changed.' });
        return;
      }
      fresh = false;
    }
    if (stopped || !supported || !opts.settled()) return;
    halt = false;
    const leading = opts.leading();
    // From memory when this tab is the one changing the shelf; a tab that only watches
    // reads the disk, since the changes are another tab's.
    if (!shelf || !leading) shelf = new Map((await listShelf(opts.userId, 'kept')).map((f) => [at(f.noteId, f.name), f]));
    const held = shelf;
    const todo = plan(opts.snapshot(), kept, [...held.values()]);
    set({ counted: true, wanted: todo.wanted, have: todo.have });
    if (!leading) return;
    for (const f of fresh ? todo.remove : []) {
      await removeFile(opts.userId, 'kept', f.noteId, f.name).then(
        () => held.delete(at(f.noteId, f.name)),
        () => {
          shelf = null;
        },
      );
    }
    if (fresh && todo.remove.length > 0) tell('shelf');
    if (todo.fetch.length === 0 || offlineNow()) {
      set({ fetching: false, problem: null });
      return;
    }
    set({ fetching: true, problem: null });
    const have = { ...todo.have };
    try {
      for (const f of todo.fetch) {
        if (stopped || halt) return;
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
        held.set(at(f.noteId, shelfName(f.filename)), { noteId: f.noteId, name: shelfName(f.filename), size: f.size });
        cutOff = 0;
        have.files += 1;
        have.bytes += f.size;
        set({ have: { ...have } });
        if (Date.now() - told > 5000) {
          told = Date.now();
          tell('shelf');
        }
      }
      tell('shelf');
    } catch (err) {
      // Whatever went wrong, memory may no longer be what the disk holds.
      shelf = null;
      /*
       * The connection went while a file was on its way: `request` only hears a fetch
       * that never answered, and a body that dies part-way is a `TypeError` out of the
       * stream instead. That is the takeoff, not a fault — the connectivity store is
       * asked to check, and the file is asked for again shortly: by then the app knows it
       * is offline and the pass stands down, or the connection was only flaky and the
       * file arrives. A few times, not for ever — a stream that fails every time on a
       * connection that is up is a fault after all, and is said.
       * (The half-written file was never swapped in; see `writeFile`.)
       */
      if (err instanceof TypeError && cutOff < 3) {
        cutOff += 1;
        recheck();
        nudge();
        return;
      }
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
  run();

  /** Changes the list, from the list as it is on the device: never from one that could not be read. */
  const save = async (change: (current: Set<string>) => Set<string>) => {
    await read();
    const next = change(kept);
    await writeKeptNotebooks(opts.userId, [...next]);
    if ([...kept].some((id) => !next.has(id))) halt = true;
    kept = next;
    set({ kept });
    tell('list');
    run();
  };

  return {
    status: () => state,
    subscribe: (l) => {
      listeners.add(l);
      l(state);
      return () => void listeners.delete(l);
    },
    keep: (id) => save((current) => new Set([...current, id])),
    release: (id) => save((current) => new Set([...current].filter((k) => k !== id))),
    releaseAll: async () => {
      await writeKeptNotebooks(opts.userId, []);
      known = true;
      kept = new Set();
      halt = true;
      // The whole shelf at once, rather than a pass removing it a file at a time.
      await clearShelf(opts.userId, 'kept');
      shelf = null;
      set({ kept, wanted: { files: 0, bytes: 0 }, have: { files: 0, bytes: 0 }, problem: null });
      tell('list');
    },
    nudge,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      channel?.close();
    },
  };
}

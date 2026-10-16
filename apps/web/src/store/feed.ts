import type { FeedAttachment, FeedEntity, FeedNote, FeedNotebook, FeedPage, FeedReset, FeedTag, SnapshotPage } from '@unbent/shared';

/**
 * The reader of the change feed: what keeps the local copy of the library current.
 *
 * Four collections (notes, notebooks, tags, files) each hand the engine their sync
 * controls when they start, and the engine applies every page of the feed across all
 * four in one go, then moves the cursor. The engine knows nothing about SQLite or React:
 * it is given a way to fetch JSON, a place to keep the cursor, and the controls, which
 * is what lets a test drive it with a fake server and fake collections.
 *
 * Two ways in. With no cursor the library is walked whole through the snapshot, page by
 * page. After each page the walk's position is stored (the `seq` the first page
 * reported, and the page to continue from) so a walk cut short by a closed tab resumes
 * where it stopped rather than from nothing (an archive on a phone is minutes of pages),
 * and the feed is then followed from that `seq`, so anything written during the walk is
 * replayed by it afterwards (every apply is an upsert). With a cursor and no page to
 * resume, pages of the feed are pulled until one is not full. A `reset` (the cursor from
 * another epoch, past the counter, or pruned) empties all four collections and walks
 * again; the feed is never applied over a stale cursor.
 *
 * When to pull is the caller's: on open, when the tab is shown again, when the
 * connection returns, when the socket says the feed moved, and after each replayed write.
 * Pulls coalesce: one runs at a time, and a request during a run queues one more. The one
 * pull the engine schedules itself is the retry of a copy that is not whole (`retry`).
 */

export interface Cursor {
  seq: number;
  epoch: string;
}

/**
 * What is kept between pulls: the cursor, and while a first copy is under way, the
 * snapshot page to resume from and the total the first page reported for the progress
 * line. A position with `resume` is a copy not yet complete; the feed is not followed
 * from it until the walk ends.
 */
export interface Position extends Cursor {
  resume?: string | null;
  total?: number | null;
}

/** What a collection's sync function gives the engine, plus whether it holds a key. */
export interface Controls<T extends object> {
  begin: () => void;
  write: (message: { type: 'insert' | 'update'; value: T } | { type: 'delete'; key: string }) => void;
  commit: () => unknown;
  truncate: () => void;
  markReady: () => void;
  has: (key: string) => boolean;
  /** Every row the collection holds, for the file rows a note's change replaces. */
  values: () => Iterable<T>;
}

export interface FeedControls {
  note: Controls<FeedNote>;
  notebook: Controls<FeedNotebook>;
  tag: Controls<FeedTag>;
  attachment: Controls<FeedAttachment>;
}

export interface FeedState {
  /** `starting` until the first pull settles; then `current`, `hydrating`, `failed`, or `reset`. */
  phase: 'starting' | 'hydrating' | 'current' | 'failed' | 'reset';
  cursor: Cursor | null;
  /** The last pull's error message, cleared by the next pull that succeeds. */
  lastError: string | null;
  /** During hydration: how many notes the walk will visit, and how many it has applied. */
  total: number | null;
  applied: number;
  pulls: number;
  /**
   * How many times the collections have been emptied and walked again: on a `reset` from
   * the server, and on a stored walk position it refuses for good. What a view that holds
   * a copy of a row outside the collections (the workspace's base for the open note)
   * watches, since after one the row it holds may be newer than the truth, not older
   * (an operator's wind-back; MAK-196), and a timestamp alone cannot tell it so.
   */
  resets: number;
}

/**
 * Whether the library holds the whole account: a walk of it has finished, whether or not
 * the latest pull did. A cursor in the state means exactly that: it is set from a stored
 * position with no page left to resume, or at the end of a walk. Not "the last pull
 * succeeded": a device opened on a plane never has one, and its copy is still whole. Not
 * during a walk either, and not while a `reset` has emptied the collections to start one.
 *
 * One answer for everything that must not act on half a library: the keeper of files and
 * the search index (`settled` in `library.ts`), the outbox's wait for a pull after a
 * replayed write (`settled` in `actions.ts`), and the list's empty state, which would
 * otherwise tell someone mid-copy that they have no notes.
 */
export function isWhole(state: Pick<FeedState, 'cursor' | 'phase'>): boolean {
  return state.cursor !== null && state.phase !== 'hydrating' && state.phase !== 'reset';
}

export interface FeedOptions {
  /** `signal` is aborted by `stop`, so a page in flight does not hold a close behind it. */
  fetchJson: <T>(path: string, signal?: AbortSignal) => Promise<T>;
  readCursor: () => Promise<Position | null>;
  writeCursor: (position: Position | null) => Promise<void>;
  pageSize?: number;
  onState?: (state: FeedState) => void;
  /**
   * The collections have been emptied for a walk from nothing, called once every
   * truncate has committed and before the cursor is cleared. `resets` in the state moves
   * as the emptying begins, which is right for a view that holds a copy of a row and
   * must stop trusting it; a cache that will be read again must be dropped only once the
   * old rows are gone, or a read in between fills it with them (found in review).
   */
  onTruncated?: () => void;
  /**
   * A pull failed, with what it threw. `lastError` keeps the message for the view; this is
   * for the error reports, which nothing in the state reached before: a first copy that
   * failed on every device would have been seen by nobody.
   */
  onError?: (err: unknown) => void;
  /** The first wait before a failed copy is tried again; doubles to `RETRY_MAX_MS`. */
  retryMs?: number;
  /**
   * A step of a pull has not settled after `stallMs`. Called once per stalled step, which
   * keeps waiting: this reports a hang, it does not end one. See `watched`.
   */
  onStall?: (err: FeedStallError) => void;
  stallMs?: number;
}

/** What `onStall` is given: which step, and whether a copy or the feed was waiting on it. */
export class FeedStallError extends Error {
  constructor(
    readonly step: StallStep,
    readonly during: 'copy' | 'feed',
    ms: number,
  ) {
    super(`Library ${during}: ${step} has not settled after ${ms / 1000} s`);
    this.name = 'FeedStallError';
  }
}

type StallStep = 'reading the cursor' | 'writing the cursor' | 'applying a page' | 'emptying the copy';

/** The longest wait between tries of a copy that keeps failing. */
const RETRY_MAX_MS = 5 * 60 * 1000;

export class FeedEngine {
  readonly state: FeedState = { phase: 'starting', cursor: null, lastError: null, total: null, applied: 0, pulls: 0, resets: 0 };
  private controls: Partial<FeedControls> = {};
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private readonly stopping = new AbortController();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryWait = 0;

  constructor(private readonly options: FeedOptions) {}

  /** A collection's sync function calls this when it starts; the first pull runs once all four have. */
  register<K extends FeedEntity>(entity: K, controls: FeedControls[K]): () => void {
    (this.controls as Record<string, unknown>)[entity] = controls;
    // Ready as soon as persistence has restored the rows (the wrapper holds this call
    // until then) not after the first pull: offline, what was restored is what there is,
    // and a cold open shows the pages as they arrive rather than a blank until the walk
    // ends. `state.phase` says whether the copy is current.
    controls.markReady();
    if (this.all()) void this.pull();
    return () => {
      delete (this.controls as Record<string, unknown>)[entity];
    };
  }

  /**
   * Ends the engine, and the pull in flight with it. `close` awaits `settled` before it
   * lets go of the collections, and sign-out and an account switch wait on `close`, so a
   * page that was not answering held both, for good before the fetch had a timeout, and
   * a minute after. Aborted, the page fails at once and nothing is reported for it.
   * A commit to the persistence worker cannot be taken back, and is still waited for.
   */
  stop(): void {
    this.stopped = true;
    this.cancelRetry();
    this.stopping.abort();
  }

  /** Resolves when the pull in flight, if any, has settled; for tests and shutdown. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /**
   * Writes rows the server has just answered a write with, as a page of the feed would:
   * the copy is current for those notes the moment the write is acknowledged, with no
   * request, and the feed's own delivery of the same rows later is an upsert of the same
   * thing. Each row carries the files the note holds, as a feed row does, since a note
   * row replaces its files. False when the collections are not registered yet.
   */
  applyNotes(notes: FeedNote[]): boolean {
    if (!this.all()) return false;
    this.apply(notes, [], [], [], [], [], [], []);
    return true;
  }

  /** The four collections' controls once every one has registered, else null. */
  private all(): FeedControls | null {
    const c = this.controls;
    return c.note && c.notebook && c.tag && c.attachment ? (c as FeedControls) : null;
  }

  /** Brings the copy current. Coalesced; never rejects: the outcome is in `state`. */
  pull(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    if (!this.all() || this.stopped) return Promise.resolve();
    this.cancelRetry();
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.once();
          this.state.phase = 'current';
          this.state.lastError = null;
        } while (this.again && !this.stopped);
        this.retryWait = 0;
      } catch (err) {
        this.state.lastError = err instanceof Error ? err.message : String(err);
        this.state.phase = 'failed';
        // A pull ended by `stop` failed because it was asked to, not because of a fault.
        if (!this.stopped) this.options.onError?.(err);
        this.retry();
      } finally {
        this.state.pulls += 1;
        this.running = null;
        this.changed();
      }
    })();
    return this.running;
  }

  /**
   * Tries a failed pull again, after a wait that doubles each time, but only while the
   * copy is not whole: a first walk, or the walk after a `reset`, that stopped partway.
   *
   * Everywhere else pulls are event-driven, and a failed pull over a whole library waits
   * for the next event: the device is offline, or the server is having a moment, and the
   * copy it has is complete. A copy that is not whole has no such floor. Before this, a
   * first walk that failed waited for focus, the socket or the connection to come back,
   * and none of those happens to a tab someone is sitting in front of with a working
   * connection: the list stayed empty. A walk resumes from its stored position, so a
   * retry repeats at most one page. Never a polling loop: it stops the moment the copy is
   * whole, and any other pull in the meantime takes its place.
   */
  private retry(): void {
    if (this.stopped || isWhole(this.state)) return;
    const base = this.options.retryMs ?? 2000;
    this.retryWait = Math.min(this.retryWait ? this.retryWait * 2 : base, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.pull();
    }, this.retryWait);
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Waits on a step that has no timeout of its own, and says so if it takes too long.
   *
   * A pull that never settles throws nothing, so nothing reported it: a first copy stuck
   * on "Copying your notes to this device…" until a reload left no trace on the device or
   * the server (2026-10-08). The steps watched are the ones inside the browser: the
   * cursor's reads and writes, and the commits of a page into the collections, which wait
   * on the persistence worker and its file. The fetches are not: `fetchJson` gives each a
   * timeout, which ends the hang as well as reporting it, and watching them too would say
   * the same thing twice. The message is the step and the phase alone, so a stall at the
   * same place groups as one report however far the copy had got.
   */
  private async watched<T>(step: StallStep, work: Promise<T>): Promise<T> {
    const onStall = this.options.onStall;
    if (!onStall) return work;
    const ms = this.options.stallMs ?? 60_000;
    // Not the cursor alone: a reset empties the copy with the old cursor still set, and a
    // walk's last cursor write sets it just before writing it. Both are a copy.
    const during = isWhole(this.state) ? 'feed' : 'copy';
    // A library closed while the step waits is not a stall anyone needs to hear about.
    const timer = setTimeout(() => {
      if (!this.stopped) onStall(new FeedStallError(step, during, ms));
    }, ms);
    try {
      return await work;
    } finally {
      clearTimeout(timer);
    }
  }

  private changed(): void {
    this.options.onState?.({ ...this.state });
  }

  private async once(): Promise<void> {
    if (!this.state.cursor) {
      const stored = await this.watched('reading the cursor', this.options.readCursor());
      if (!stored || stored.resume) {
        await this.snapshot(stored);
        return;
      }
      this.state.cursor = { seq: stored.seq, epoch: stored.epoch };
    }
    const limit = this.options.pageSize ?? 200;
    for (;;) {
      const c = this.state.cursor;
      const page = await this.options.fetchJson<FeedPage | FeedReset>(
        `/api/changes?since=${c.seq}&epoch=${encodeURIComponent(c.epoch)}&limit=${limit}`,
        this.stopping.signal,
      );
      if (page.reset) {
        this.state.phase = 'reset';
        this.changed();
        await this.truncateAll();
        await this.snapshot(null);
        return;
      }
      await this.apply(page.notes, page.tombstones.filter((t) => t.entity === 'note').map((t) => t.id), page.notebooks, page.tombstones.filter((t) => t.entity === 'notebook').map((t) => t.id), page.tags, page.tombstones.filter((t) => t.entity === 'tag').map((t) => t.id), page.attachments, page.tombstones.filter((t) => t.entity === 'attachment').map((t) => t.id));
      await this.moveCursor({ seq: page.next, epoch: page.epoch });
      if (!page.more) return;
    }
  }

  /** The whole library, page by page: from the start, or from where an earlier walk stopped. */
  private async snapshot(from: Position | null): Promise<void> {
    this.state.phase = 'hydrating';
    // Resuming: what the earlier walk applied is in the collection already.
    this.state.applied = from ? count(this.all()?.note.values()) : 0;
    this.state.total = from?.total ?? null;
    this.changed();
    const limit = this.options.pageSize ?? 200;
    let cursor: string | null = from?.resume ?? null;
    let seeded: Cursor | null = from ? { seq: from.seq, epoch: from.epoch } : null;
    do {
      if (this.stopped) return;
      let page: SnapshotPage;
      try {
        page = await this.options.fetchJson(
          `/api/changes/snapshot?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          this.stopping.signal,
        );
      } catch (err) {
        /*
         * A stored position the server refuses (a page cursor from before its shape
         * changed, say) would fail the same way on every pull, and a walk with a
         * position never reaches the feed's `reset`. Refused for good, the walk starts
         * over from nothing, as a reset does: the rows the first attempt applied go too,
         * since a note purged in between is in neither the new snapshot nor the feed from
         * its `seq`, and kept it would have stayed on the device for good (review of
         * #232). Refused for now, the position is kept and tried again.
         */
        if (from && cursor && deadCursor(err)) {
          await this.truncateAll();
          await this.snapshot(null);
          return;
        }
        throw err;
      }
      if (!seeded) {
        seeded = { seq: page.seq, epoch: page.epoch };
        this.state.total = page.total ?? null;
      }
      await this.apply(page.notes, [], page.notebooks ?? [], [], page.tags ?? [], [], [], []);
      this.state.applied += page.notes.length;
      cursor = page.next;
      // The position once this page's rows have settled on disk, so a walk cut short here
      // continues from the next page; the cursor itself only once the walk is whole.
      if (cursor) {
        await this.watched('writing the cursor', this.options.writeCursor({ ...seeded, resume: cursor, total: this.state.total }));
        this.changed();
      }
    } while (cursor);
    await this.moveCursor(seeded);
  }

  private async moveCursor(cursor: Cursor | null): Promise<void> {
    this.state.cursor = cursor;
    await this.watched('writing the cursor', this.options.writeCursor(cursor));
    this.changed();
  }

  /**
   * Empties every collection: for a `reset`, and for a stored walk position the server
   * refuses for good. Each truncate is its own sync transaction, awaited. TanStack DB's
   * `truncate` marks the *pending* transaction and throws when there is none, so a bare
   * `truncate()` failed the pull, which swallowed the error into `lastError` and kept the
   * stale cursor: a device wound back by an operator kept its old rows for good and
   * pulled in a loop. The commit is awaited for the reason `apply`'s are: a cursor gone
   * from disk before the rows are would make the next open walk the snapshot over them,
   * keeping a note purged on the server. A commit that fails partway through the loop
   * leaves the cursor in place, so the next pull is answered with `reset` again and
   * finishes the job; the half-emptied library in between is accepted over a cursor
   * cleared ahead of rows that are still there.
   */
  private async truncateAll(): Promise<void> {
    const all = this.all();
    if (!all) return;
    this.state.resets += 1;
    this.changed();
    for (const c of Object.values(all)) {
      c.begin();
      c.truncate();
      await this.watched('emptying the copy', Promise.resolve(c.commit()));
    }
    this.options.onTruncated?.();
    await this.moveCursor(null);
  }

  /**
   * One page across the four collections. A note row replaces the note and its files
   * (the feed carries them with the note); a note tombstone takes its files with it, as
   * the server's cascade did. Each collection gets one transaction for the page.
   *
   * Settles once every collection's commit has: the persistence layer queues each
   * collection's writes on a mutex of its own, so a notes commit still waiting behind an
   * earlier page's can reach disk after the cursor collection's row does, and a tab
   * closed in between would reopen with a position past rows that never landed. Every
   * cursor write waits for this, which also means a walk fetches its next page only once
   * the last has settled; on a phone the walk was bound by persistence anyway.
   *
   * The wait is safe only because a commit is applied when it arrives (`feedControls` in
   * `collections.ts`). A commit TanStack DB held back behind a write in flight would hold
   * this pull, and an outbox entry's replay waits on a pull: a single trash waited on
   * itself.
   */
  private async apply(
    notes: FeedNote[],
    noteTombstones: string[],
    notebooks: FeedNotebook[],
    notebookTombstones: string[],
    tags: FeedTag[],
    tagTombstones: string[],
    attachments: FeedAttachment[],
    attachmentTombstones: string[],
  ): Promise<void> {
    const all = this.all();
    if (!all) return;
    const { note, notebook, tag, attachment } = all;

    // The files each touched note holds now, so a note's change can drop the ones that went.
    const touched = new Set([...notes.map((n) => n.id), ...noteTombstones]);
    const heldByNote = new Map<string, string[]>();
    if (touched.size > 0) {
      for (const a of attachment.values()) {
        if (!touched.has(a.noteId)) continue;
        const list = heldByNote.get(a.noteId) ?? [];
        list.push(a.id);
        heldByNote.set(a.noteId, list);
      }
    }

    const commits = [
      upsertAll(note, notes, (n) => n.id, noteTombstones),
      upsertAll(notebook, notebooks, (n) => n.id, notebookTombstones),
      upsertAll(tag, tags, (t) => t.id, tagTombstones),
    ];

    const files: FeedAttachment[] = [...attachments];
    const gone = new Set<string>(attachmentTombstones);
    for (const n of notes) {
      const keep = new Set(n.files.map((f) => f.id));
      for (const id of heldByNote.get(n.id) ?? []) if (!keep.has(id)) gone.add(id);
      files.push(...n.files);
    }
    for (const id of noteTombstones) for (const held of heldByNote.get(id) ?? []) gone.add(held);
    commits.push(upsertAll(attachment, files, (f) => f.id, [...gone]));
    await this.watched('applying a page', Promise.all(commits));
  }
}

/**
 * A status the server would answer the same way however often it is asked: a 4xx, but
 * not 401 (the session: the sign-in that follows should carry on), 408 (a timeout) or
 * 429 ("later"). The outbox ends an entry on one (`refusal` in `actions.ts`) and the walk
 * drops a stored resume on one; both read this, so a status added for one is added for
 * the other. The iOS capture queue carves out the same three (`CaptureJob.isPermanent`).
 *
 * Counting those three as for good is what this exists to prevent: in the outbox it
 * deleted the only copy of a file added offline, and in the walk it emptied the copy a
 * first walk had already applied (minutes of pages on a phone) so a refused session's
 * store came back empty instead of picking up where it stopped.
 */
export function refusedForGood(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 408, 429].includes(status);
}

/** The engine is given its fetch, so the error is read for a status rather than typed. */
function deadCursor(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && refusedForGood(status);
}

function count(rows: Iterable<unknown> | undefined): number {
  let n = 0;
  for (const _ of rows ?? []) n += 1;
  return n;
}

/** The transaction's commit, to await: see `apply`. Nothing to write is nothing to wait for. */
function upsertAll<T extends object>(c: Controls<T>, rows: T[], keyOf: (row: T) => string, deletes: string[]): Promise<unknown> | undefined {
  if (rows.length === 0 && deletes.length === 0) return undefined;
  c.begin();
  // Last word per key within the page, in case a row and its tombstone both arrived.
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    seen.add(key);
    c.write({ type: c.has(key) ? 'update' : 'insert', value: row });
  }
  for (const key of deletes) if (!seen.has(key) && c.has(key)) c.write({ type: 'delete', key });
  return Promise.resolve(c.commit());
}

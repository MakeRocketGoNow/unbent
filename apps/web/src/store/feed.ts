import type { FeedAttachment, FeedEntity, FeedNote, FeedNotebook, FeedPage, FeedReset, FeedTag, SnapshotPage } from '@unbent/shared';

/**
 * The reader of the change feed: what keeps the local copy of the library current.
 *
 * Four collections — notes, notebooks, tags, files — each hand the engine their sync
 * controls when they start, and the engine applies every page of the feed across all
 * four in one go, then moves the cursor. The engine knows nothing about SQLite or React:
 * it is given a way to fetch JSON, a place to keep the cursor, and the controls, which
 * is what lets a test drive it with a fake server and fake collections.
 *
 * Two ways in. With no cursor the library is walked whole through the snapshot, page by
 * page. After each page the walk's position is stored — the `seq` the first page
 * reported, and the page to continue from — so a walk cut short by a closed tab resumes
 * where it stopped rather than from nothing (an archive on a phone is minutes of pages),
 * and the feed is then followed from that `seq`, so anything written during the walk is
 * replayed by it afterwards (every apply is an upsert). With a cursor and no page to
 * resume, pages of the feed are pulled until one is not full. A `reset` — the cursor from
 * another epoch, past the counter, or pruned — empties all four collections and walks
 * again; the feed is never applied over a stale cursor.
 *
 * When to pull is the caller's: on open, when the tab is shown again, when the
 * connection returns, when the socket says the feed moved, and after each replayed write.
 * Pulls coalesce: one runs at a time, and a request during a run queues one more.
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
}

export interface FeedOptions {
  fetchJson: <T>(path: string) => Promise<T>;
  readCursor: () => Promise<Position | null>;
  writeCursor: (position: Position | null) => Promise<void>;
  pageSize?: number;
  onState?: (state: FeedState) => void;
}

export class FeedEngine {
  readonly state: FeedState = { phase: 'starting', cursor: null, lastError: null, total: null, applied: 0, pulls: 0 };
  private controls: Partial<FeedControls> = {};
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(private readonly options: FeedOptions) {}

  /** A collection's sync function calls this when it starts; the first pull runs once all four have. */
  register<K extends FeedEntity>(entity: K, controls: FeedControls[K]): () => void {
    (this.controls as Record<string, unknown>)[entity] = controls;
    // Ready as soon as persistence has restored the rows — the wrapper holds this call
    // until then — not after the first pull: offline, what was restored is what there is,
    // and a cold open shows the pages as they arrive rather than a blank until the walk
    // ends. `state.phase` says whether the copy is current.
    controls.markReady();
    if (this.all()) void this.pull();
    return () => {
      delete (this.controls as Record<string, unknown>)[entity];
    };
  }

  stop(): void {
    this.stopped = true;
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

  /** Brings the copy current. Coalesced; never rejects — the outcome is in `state`. */
  pull(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    if (!this.all() || this.stopped) return Promise.resolve();
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.once();
          this.state.phase = 'current';
          this.state.lastError = null;
        } while (this.again && !this.stopped);
      } catch (err) {
        this.state.lastError = err instanceof Error ? err.message : String(err);
        this.state.phase = 'failed';
      } finally {
        this.state.pulls += 1;
        this.running = null;
        this.changed();
      }
    })();
    return this.running;
  }

  private changed(): void {
    this.options.onState?.({ ...this.state });
  }

  private async once(): Promise<void> {
    if (!this.state.cursor) {
      const stored = await this.options.readCursor();
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
      );
      if (page.reset) {
        this.state.phase = 'reset';
        this.changed();
        await this.truncateAll();
        await this.snapshot(null);
        return;
      }
      this.apply(page.notes, page.tombstones.filter((t) => t.entity === 'note').map((t) => t.id), page.notebooks, page.tombstones.filter((t) => t.entity === 'notebook').map((t) => t.id), page.tags, page.tombstones.filter((t) => t.entity === 'tag').map((t) => t.id), page.attachments, page.tombstones.filter((t) => t.entity === 'attachment').map((t) => t.id));
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
        );
      } catch (err) {
        /*
         * A stored position the server refuses — a page cursor from before its shape
         * changed, say — would fail the same way on every pull, and a walk with a
         * position never reaches the feed's `reset`. Refused for good, the walk starts
         * over from nothing, as a reset does: the rows the first attempt applied go too,
         * since a note purged in between is in neither the new snapshot nor the feed from
         * its `seq`, and kept it would have stayed on the device for good (review of
         * #232). Refused for now, the position is kept and tried again.
         */
        if (from && cursor && refusedForGood(err)) {
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
      this.apply(page.notes, [], page.notebooks ?? [], [], page.tags ?? [], [], [], []);
      this.state.applied += page.notes.length;
      cursor = page.next;
      // The position after this page's rows have committed, so a walk cut short here
      // continues from the next page; the cursor itself only once the walk is whole.
      if (cursor) {
        await this.options.writeCursor({ ...seeded, resume: cursor, total: this.state.total });
        this.changed();
      }
    } while (cursor);
    await this.moveCursor(seeded);
  }

  private async moveCursor(cursor: Cursor | null): Promise<void> {
    this.state.cursor = cursor;
    await this.options.writeCursor(cursor);
    this.changed();
  }

  private async truncateAll(): Promise<void> {
    const all = this.all();
    if (!all) return;
    for (const c of Object.values(all)) c.truncate();
    await this.moveCursor(null);
  }

  /**
   * One page across the four collections. A note row replaces the note and its files
   * (the feed carries them with the note); a note tombstone takes its files with it, as
   * the server's cascade did. Each collection gets one transaction for the page.
   */
  private apply(
    notes: FeedNote[],
    noteTombstones: string[],
    notebooks: FeedNotebook[],
    notebookTombstones: string[],
    tags: FeedTag[],
    tagTombstones: string[],
    attachments: FeedAttachment[],
    attachmentTombstones: string[],
  ): void {
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

    upsertAll(note, notes, (n) => n.id, noteTombstones);
    upsertAll(notebook, notebooks, (n) => n.id, notebookTombstones);
    upsertAll(tag, tags, (t) => t.id, tagTombstones);

    const files: FeedAttachment[] = [...attachments];
    const gone = new Set<string>(attachmentTombstones);
    for (const n of notes) {
      const keep = new Set(n.files.map((f) => f.id));
      for (const id of heldByNote.get(n.id) ?? []) if (!keep.has(id)) gone.add(id);
      files.push(...n.files);
    }
    for (const id of noteTombstones) for (const held of heldByNote.get(id) ?? []) gone.add(held);
    upsertAll(attachment, files, (f) => f.id, [...gone]);
  }
}

/** A 4xx: the server will answer the same request the same way again. */
function refusedForGood(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function count(rows: Iterable<unknown> | undefined): number {
  let n = 0;
  for (const _ of rows ?? []) n += 1;
  return n;
}

function upsertAll<T extends object>(c: Controls<T>, rows: T[], keyOf: (row: T) => string, deletes: string[]): void {
  if (rows.length === 0 && deletes.length === 0) return;
  c.begin();
  // Last word per key within the page, in case a row and its tombstone both arrived.
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    seen.add(key);
    c.write({ type: c.has(key) ? 'update' : 'insert', value: row });
  }
  for (const key of deletes) if (!seen.has(key) && c.has(key)) c.write({ type: 'delete', key });
  c.commit();
}

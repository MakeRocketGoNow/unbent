import type { AttachmentTexts } from '@unbent/shared';
import type { LocalAttachment } from './collections.js';
import type { LocalNote, Snapshot } from './derive.js';
import type { Entry, SearchIndex } from './search-index.js';
import { BUILT, fieldEntryPrefix, heldText, noteEntries, tagEntries, textPlan, textStamp } from './search-local.js';

/**
 * Keeps the search index in step with the library: the part of offline search that
 * writes.
 *
 * The library's rows are the truth and the index is a derivation of them that lives in
 * another file, so nothing makes the two agree but this. It runs in passes, the way the
 * keeper of offline files does (`keep.ts`) and for the same reasons: the library changes
 * in bursts, a pass must be able to stop and be picked up later, and only one tab of an
 * account should be doing it. A pass does three things, each only when something says it
 * is needed:
 *
 *  - **Notes.** The first pass after the library is whole compares every live note with
 *    what is indexed, by stamp, and writes the difference; after that the library names
 *    the notes that changed (`touch`) and a pass reads only those. A device that was
 *    closed mid-edit is put right by the next first pass.
 *  - **Tags.** All of them, whenever anything but a note's text changed. There are a few
 *    hundred at most.
 *  - **Files' text.** What `textPlan` says should be here and is not is fetched from the
 *    server, a request at a time, while there is a connection; what it says should not be
 *    is dropped, and what the opened notes have no room for is let go.
 *
 * A file's text is fetched once. One read again on the server — a scan the vision model
 * took a second pass at — keeps its old text here until the file leaves and returns, or
 * the library starts over (`startOver`):
 * the feed's row for a file says only that it has text, not which, and asking again on
 * every row the feed delivers would fetch a notebook's text on every edit to it.
 */

export interface SearchSyncOptions {
  index: SearchIndex;
  snapshot: () => Snapshot;
  /** Whether the library holds the whole account; see `KeeperOptions.settled`. A pass over half a library would drop the other half from the index. */
  settled: () => boolean;
  /** Whether this tab does the account's background work; two tabs would index everything twice. */
  leading: () => boolean;
  /** The notebooks kept offline on this device, by id. Rejects when the list cannot be read, and nothing is dropped on its word. */
  kept: () => Promise<string[]>;
  offline: () => boolean;
  /**
   * `POST /api/attachments/texts`. Rejects with whatever the request layer throws when
   * there is no connection, and must give up when the signal aborts: `stop` waits for the
   * pass in hand, and a sign-out waits for `stop`.
   */
  fetchTexts: (ids: string[], signal: AbortSignal) => Promise<AttachmentTexts>;
  /** Whether an error is the absence of a connection, which ends a pass quietly. */
  isOffline: (err: unknown) => boolean;
  /**
   * A name for the channel the account's tabs tell each other on, when there is one. A
   * note opened in a tab that does not lead is recorded there and fetched here.
   */
  channel?: string;
}

export interface SearchSync {
  /** A note changed; `null` when the change cannot be named, which is every note. */
  touch: (noteIds: Iterable<string> | null, opts?: { textOnly?: boolean }) => void;
  /** Something moved that decides which files' text is wanted: a file, the kept list, the connection. */
  touchFiles: () => void;
  /**
   * The library is starting over: the feed refused its cursor — a restore on the server,
   * say — and the collections are emptied and copied again. The index is emptied before
   * the next pass rather than compared, because a comparison cannot see a file's text: an
   * id that survives the restore would keep the text it was first indexed with.
   */
  startOver: () => void;
  /** Asks for a pass with nothing new to look at: the library may have become whole, or this tab the leader. */
  wake: () => void;
  /** A note was opened here: its files' text is wanted for as long as it is among the last few hundred. */
  opened: (noteId: string) => Promise<void>;
  /** Resolves when no pass is running or waiting to; for tests and the offline gate. */
  idle: () => Promise<void>;
  /** Stops, and resolves once the pass in hand has let go of the index, so the index can be closed. */
  stop: () => Promise<void>;
}

/** Ids a request for text carries; the server takes fifty and cuts its answer on bytes. */
const TEXT_BATCH = 25;
/** Notes compared before the pass lets the page breathe: hashing an archive's bodies in one go is a dropped frame or several. */
const SLICE = 500;

export function createSearchSync(opts: SearchSyncOptions): SearchSync {
  const { index } = opts;
  let stopped = false;
  /*
   * Aborted by `stop`. A pass can be inside a request for text when the library closes,
   * and on a connection that has stalled that request is minutes from failing; closing
   * the library is what a sign-out and an account switch wait on, so the request is
   * ended rather than waited for. The keeper's `stop` does not wait on its fetches at
   * all; this one has to, because the index is closed next and a write after that is an
   * error.
   */
  const abort = new AbortController();
  let running: Promise<void> | null = null;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** What the next pass has to look at. Everything, until a pass over everything has finished. */
  let everything = true;
  let dirty = new Set<string>();
  let tagsDirty = true;
  let filesDirty = true;
  /** Set by `startOver`; the next pass that runs empties the index first. */
  let emptyFirst = false;

  const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  /** Handed to every write to the index, which asks it between batches; see `SearchIndex.put`. */
  const halted = () => stopped;

  /** Brings the notes' and their fields' entries to what the library holds: all of them, or the ones named. */
  async function notes(ids: Set<string> | null): Promise<void> {
    const snapshot = opts.snapshot();
    const live = new Map<string, LocalNote>();
    for (const n of snapshot.notes) if (n.deletedAt === undefined && (!ids || ids.has(n.id))) live.set(n.id, n);

    const [haveNotes, haveFields] = ids
      ? await Promise.all([index.stamps('note', [...ids]), index.stampsUnder('field', [...ids].map(fieldEntryPrefix))])
      : await Promise.all([index.stamps('note'), index.stamps('field')]);

    const putNotes: Entry[] = [];
    const putFields: Entry[] = [];
    const wantedFields = new Set<string>();
    let seen = 0;
    for (const note of live.values()) {
      const entries = noteEntries(note);
      if (haveNotes.get(note.id) !== entries.note.stamp) putNotes.push(entries.note);
      for (const f of entries.fields) {
        wantedFields.add(f.id);
        if (haveFields.get(f.id) !== f.stamp) putFields.push(f);
      }
      seen += 1;
      if (seen % SLICE === 0) {
        await yieldToPage();
        if (stopped) return;
      }
    }
    await index.drop('note', [...haveNotes.keys()].filter((id) => !live.has(id)), halted);
    await index.drop('field', [...haveFields.keys()].filter((id) => !wantedFields.has(id)), halted);
    await index.put('note', putNotes, halted);
    await index.put('field', putFields, halted);
  }

  async function tags(): Promise<void> {
    const wanted = tagEntries(opts.snapshot());
    const have = await index.stamps('tag');
    const names = new Set(wanted.map((e) => e.id));
    await index.drop('tag', [...have.keys()].filter((name) => !names.has(name)), halted);
    await index.put('tag', wanted.filter((e) => !have.has(e.id)), halted);
  }

  /** Answers whether the files' text is as the plan wants it, so the pass knows whether to come back. */
  async function files(): Promise<boolean> {
    let kept: Set<string>;
    try {
      kept = new Set(await opts.kept());
    } catch {
      // Unknown is not empty: a pass over an empty list would drop every kept notebook's text.
      return false;
    }
    /*
     * One request for text a round, and the plan made again after it. A file's length is
     * only known once its text is here, so each answer can take the opened notes past
     * their limit; planning per request means at most one answer's worth is fetched
     * beyond it before the plan lets go of what no longer fits. An id the answer had no
     * room for (`left`) is simply still missing, and the next plan asks again.
     */
    for (;;) {
      const snapshot = opts.snapshot();
      const plan = textPlan(
        { notes: snapshot.notes, attachments: snapshot.attachments as Iterable<LocalAttachment> },
        kept,
        await index.opened(),
        new Map([...(await index.stamps('file'))].map(([id, stamp]) => [id, heldText(stamp)])),
      );
      await index.drop('file', plan.remove, halted);
      // Over the limit for opened notes: the text goes and the length is remembered; see `textPlan`.
      await index.put('file', plan.shed.map((f) => ({ id: f.id, stamp: textStamp(f.chars, true), columns: [''] })), halted);

      if (plan.fetch.length === 0) return true;
      if (stopped || opts.offline()) return false;
      const asked = plan.fetch.slice(0, TEXT_BATCH);
      let answer: AttachmentTexts;
      try {
        answer = await opts.fetchTexts(asked, abort.signal);
      } catch (err) {
        if (stopped || opts.isOffline(err)) return false;
        throw err;
      }
      const left = new Set(answer.left);
      const got = new Map(answer.texts.map((t) => [t.id, t.text]));
      /*
       * A file asked for and neither answered nor left over has no text on the server —
       * gone since the plan was made, or read and found empty. It is indexed as empty so
       * the next plan does not ask again; if it has gone, the feed says so and the plan
       * drops it.
       */
      await index.put(
        'file',
        asked.filter((id) => !left.has(id)).map((id) => ({ id, stamp: textStamp((got.get(id) ?? '').length), columns: [got.get(id) ?? ''] })),
        halted,
      );
      // An answer that carried nothing and left everything would loop for ever; the server always answers one.
      if (left.size === asked.length) throw new Error('The server answered no text for any file asked for.');
    }
  }

  async function pass(): Promise<void> {
    if (stopped) return;
    /*
     * Not whole — the first copy is under way, or a reset has emptied the collections —
     * or not this tab's job. What was touched stays touched; and a library that is not
     * whole now will be a different library when it is, so the pass that follows looks at
     * everything.
     */
    if (!opts.settled()) {
      everything = true;
      return;
    }
    if (!opts.leading()) {
      // The leading tab hears the same changes. Should this tab lead later, it starts from a comparison of everything.
      everything = true;
      dirty = new Set();
      return;
    }

    if (emptyFirst) {
      // Cleared only once the emptying has committed, so one that fails is tried again.
      await index.clear();
      emptyFirst = false;
      everything = true;
    }
    const full = everything;
    const ids = dirty;
    const doTags = full || tagsDirty;
    const doFiles = full || filesDirty;
    everything = false;
    dirty = new Set();
    tagsDirty = false;
    filesDirty = false;
    try {
      if (full) {
        await notes(null);
      } else if (ids.size > 0) {
        await notes(ids);
      }
      if (stopped) return;
      if (doTags) await tags();
      // Until the first pass over a whole library has finished, a search says its results may be incomplete.
      if (stopped) return;
      if (full) await index.setMeta(BUILT, '1');
      if (doFiles && !(await files())) filesDirty = true;
    } catch (err) {
      // Whatever was in hand is owed again; nothing has been lost, since every step is a comparison.
      everything ||= full;
      for (const id of ids) dirty.add(id);
      tagsDirty ||= doTags;
      filesDirty ||= doFiles;
      throw err;
    }
  }

  function run(): void {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = pass()
      .catch((err: unknown) => console.error('[search] indexing pass failed:', err))
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          run();
        }
      });
  }

  /** A pass, soon: a feed page is hundreds of changes and an autosave one every second or two. */
  function nudge(): void {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, 1000);
  }

  const channel = opts.channel && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(opts.channel) : null;
  if (channel) {
    channel.onmessage = () => {
      filesDirty = true;
      nudge();
    };
  }

  run();

  return {
    touch: (noteIds, o) => {
      if (noteIds === null) everything = true;
      else for (const id of noteIds) dirty.add(id);
      if (!o?.textOnly) {
        // A note trashed, moved or retagged changes which tags exist and which files are wanted.
        tagsDirty = true;
        filesDirty = true;
      }
      nudge();
    },
    touchFiles: () => {
      filesDirty = true;
      nudge();
    },
    startOver: () => {
      emptyFirst = true;
      everything = true;
      nudge();
    },
    wake: nudge,
    opened: async (noteId) => {
      await index.markOpened(noteId);
      filesDirty = true;
      nudge();
      try {
        channel?.postMessage('opened');
      } catch {
        // Closed under us; the leading tab reads the list on its next pass anyway.
      }
    },
    idle: async () => {
      while (timer || running) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
          run();
        }
        await running;
      }
    },
    stop: async () => {
      stopped = true;
      abort.abort();
      if (timer) clearTimeout(timer);
      timer = null;
      channel?.close();
      await running;
    },
  };
}

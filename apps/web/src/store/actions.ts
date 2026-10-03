import { IndexedDBAdapter, NonRetriableError, startOfflineExecutor, type OfflineExecutor, type OnlineDetector, type StorageAdapter } from '@tanstack/offline-transactions';
import type { Transaction } from '@tanstack/db';
import type { FeedNote, FieldDef, FieldValue, Note, NoteFieldValue } from '@unbent/shared';
import * as api from '../notes-api.js';
import { ApiError, isNoteChanged, isOfflineError } from '../notes-api.js';
import { offlineNow, recheck, subscribeConnectivity } from '../connectivity.js';
import { buildNotePatch, seedFrom, holdsTheirChanges, type NoteDraft } from '../note-patch.js';
import { lookups, toNote, type Snapshot } from './derive.js';
import type { Collections, LocalNote } from './collections.js';
import type { FeedEngine } from './feed.js';
import { outboxName } from './names.js';

/**
 * Writes to notes: made on the local copy at once and replayed to the server through a
 * durable outbox, so a note can be edited, made, trashed or restored with no connection
 * and the server hears of it when there is one.
 *
 * Only note writes go this way. Notebook, tag and field management — renames, merges,
 * deletes, field definitions, option removal, conversions — are settings-page actions
 * with uniqueness and conversion rules the server decides, and stay direct calls that
 * need a connection; the feed delivers what they did to every device.
 *
 * The outbox (`@tanstack/offline-transactions`) is one queue, replayed in order, one
 * entry at a time, with a growing wait between attempts. Two rules keep the queue from
 * sticking: every answer the server will give again gets `NonRetriableError` — a 4xx, a
 * refused precondition — so the entries behind it move, and the outbox holds at most one
 * save per note. Each save carries the whole draft, so a new save of a note supersedes the
 * one still waiting: the waiting entry is removed from storage when the new one is queued
 * and does nothing when its turn comes, and the new one carries the older base forward.
 * An hour of autosaves offline is one entry and one PATCH, not thousands of copies of the
 * body collapsed at replay by reading the whole queue per entry (review of #232). A lost
 * connection and a 5xx are retried.
 *
 * Only the tab holding the outbox's lock queues. In any other tab the library hands back
 * a plain transaction that runs the write at once and rolls the change back if it fails,
 * and offline it fails — so such a tab's writes are not "queued", they are never made,
 * and saying otherwise would show "Saved" over text that was gone (review of #232). Every
 * function here therefore asks `durable` first, and in a tab that is not it does what
 * it does with no library at all: one request, the answer the server's, the refusal the
 * caller's to show, and the local copy brought up to date by a pull.
 *
 * Every function here looks the open library up and works on it; with none — a browser
 * without the file system the local copy lives in — it does what the app did before,
 * one request, and the answer is the server's.
 */

/**
 * A save the server refused because the note changed on another device, waiting on a
 * choice: the note as the server now holds it, and the draft and base the refused save
 * carried. The draft lived in the entry, and ending the entry rolled the row back to the
 * server's copy, so a conflict on a note that was not open lost the typing — reopening
 * seeded from the row, and "Keep mine" had nothing to keep (review of #232). With offline
 * editing that is the ordinary conflict: ten notes edited on a plane, one of them touched
 * on the phone meanwhile. The workspace seeds from this when it opens the note. Kept in
 * the outbox's own database until the choice is made: most of these come back during a
 * background replay, with the note closed, and a tab closed before it is opened again
 * would otherwise lose the typing one reload later (review of #232).
 */
export interface Conflict {
  current: Note;
  draft: NoteDraft;
  base: Note;
}

export interface SyncStatus {
  /** Writes made here the server has not yet accepted. */
  pending: number;
  /**
   * Whether a write queued in this tab outlives it. Only the tab holding the outbox's lock
   * stores entries; in any other tab a write is a request made at once, and offline it
   * fails as one (see `durable` below).
   */
  durable: boolean;
  /**
   * The notes with an entry waiting: what the note head marks with a glyph, so a note
   * that is only on this device can be told from one the server has. Online that is the
   * half second a replay takes; offline it is the whole stretch.
   */
  waiting: ReadonlySet<string>;
  conflicts: ReadonlyMap<string, Conflict>;
}

export interface Outbox {
  executor: OfflineExecutor;
  /** The executor initialised and the entries it restored known; the library waits for this. */
  ready: Promise<void>;
  status: () => SyncStatus;
  subscribe: (listener: (status: SyncStatus) => void) => () => void;
  /** Hears the server's copy after a replayed save of that note went through. */
  onAcknowledged: (listener: (noteId: string, note: Note) => void) => () => void;
  /** Forgets a conflict once a choice has been made. */
  resolveConflict: (noteId: string) => void;
  /**
   * Retires the save of this note still waiting in the queue, if there is one, ahead of a
   * new one: it is removed from storage, its change is taken off the row, and it will do
   * nothing when its turn comes. Answers with what the new save carries forward — the copy
   * the retired draft was made from, which is the older base, and the date it was to be
   * preconditioned on.
   */
  supersedeSave: (noteId: string) => { base: Note; against?: number | undefined } | null;
  /** Records the save of this note now waiting: its entry's id, what it carries, and how to take its change off the row. */
  trackSave: (noteId: string, entry: { id: string; base: Note; against?: number | undefined; retire: () => void }) => void;
  /** Records which notes an entry just queued is about, for `waiting`. */
  trackEntry: (id: string, noteIds: string[]) => void;
  /** Stops the executor and closes its store, so the outbox's database can be removed. */
  dispose: () => Promise<void>;
}

/** What the actions need of a library. */
export interface WritableLibrary extends Collections {
  userId: string;
  engine: FeedEngine;
  outbox: Outbox;
}

/**
 * A save: the whole draft, the copy it is diffed against for the patch, and, for "Keep
 * mine", the date to precondition on instead of the base's — the other device's copy,
 * so the patch is still only what was typed here and lands on top of theirs.
 */
type Save = { noteId: string; value: NoteDraft; base: Note; against?: number };

/** The key a conflict is kept under in the outbox's storage; its entries are the `tx:` keys. */
const conflictKey = (noteId: string) => `conflict:${noteId}`;

export function createOutbox(userId: string, lib: Omit<WritableLibrary, 'outbox'>): Outbox {
  const conflicts = new Map<string, Conflict>();
  /** The notes each waiting entry is about, by entry id. */
  const entryNotes = new Map<string, string[]>();
  const waiting = (): ReadonlySet<string> => new Set([...entryNotes.values()].flat());
  /**
   * Whether an attempt ended the entry: it went through, or the server refused it for
   * good. A lost connection or a 5xx keeps the entry, and its notes keep waiting.
   */
  const ended = (entryId: string, err?: unknown) => {
    if (err === undefined || err instanceof NonRetriableError) entryNotes.delete(entryId);
  };
  const keep = (noteId: string, conflict: Conflict) => {
    conflicts.set(noteId, conflict);
    void storage.set(conflictKey(noteId), JSON.stringify(conflict)).catch((err: unknown) => console.error('[outbox] conflict not kept:', err));
  };
  const listeners = new Set<(s: SyncStatus) => void>();
  const acks = new Set<(id: string, note: Note) => void>();
  const status = (): SyncStatus => ({ pending: storage.held(), durable: executor.isOfflineEnabled, waiting: waiting(), conflicts });
  const touch = () => {
    const s = status();
    listeners.forEach((l) => l(s));
  };

  const defs = (): FieldDef[] => [...lookups(snapshot(lib)).fieldDefs.values()];

  /** The save of each note still waiting, by entry id, and the entries a later save retired. */
  const waitingSaves = new Map<string, { id: string; base: Note; against?: number | undefined; retire: () => void }>();
  const superseded = new Set<string>();

  /** The server refused the request for good, or for now: which, is the queue's whole question. */
  const refusal = (err: unknown): never => {
    if (isOfflineError(err)) throw err;
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) throw new NonRetriableError(err.message);
    throw err;
  };

  const adapter = new IndexedDBAdapter(outboxName(userId));
  const storage = watched(adapter, () => touch());
  const executor = startOfflineExecutor({
    collections: { notes: lib.notes },
    storage,
    onlineDetector: connectivityDetector(),
    onLeadershipChange: () => touch(),
    mutationFns: {
      saveNote: async ({ transaction }) => {
        const { noteId, value, base, against } = transaction.metadata as unknown as Save;
        try {
          // A later save of this note carries the whole draft, this one included.
          if (superseded.has(transaction.id)) {
            ended(transaction.id);
            return;
          }
          const patch = buildNotePatch(value, base, defs());
          if (!patch) {
            ended(transaction.id);
            return;
          }
          let updated: Note;
          try {
            updated = await api.updateNote(noteId, { ...patch, ifUpdatedAt: against ?? base.updatedAt });
          } catch (err) {
            if (!isNoteChanged(err)) return refusal(err);
            // The note moved on the server since this draft's base. Nothing of theirs
            // would be lost if the draft already holds every change they made — the
            // usual case after this device's own earlier save went through — so that
            // goes again against the copy the refusal brought; anything else is a
            // choice to put to the person (MAK-113), and this entry is done. A "Keep
            // mine" refused in turn is that choice again, with the newer copy.
            if (against !== undefined || !holdsTheirChanges(value, base, err.current)) {
              keep(noteId, { current: err.current, draft: value, base });
              await lib.engine.pull();
              throw new NonRetriableError(`Note ${noteId} changed on another device`);
            }
            try {
              updated = await api.updateNote(noteId, { ...patch, ifUpdatedAt: err.current.updatedAt });
            } catch (again) {
              if (!isNoteChanged(again)) return refusal(again);
              keep(noteId, { current: again.current, draft: value, base });
              await lib.engine.pull();
              throw new NonRetriableError(`Note ${noteId} changed on another device`);
            }
          }
          acks.forEach((l) => l(noteId, updated));
          if (!took(updated)) await settled();
          ended(transaction.id);
        } catch (err) {
          ended(transaction.id, err);
          throw err;
        } finally {
          superseded.delete(transaction.id);
          if (waitingSaves.get(noteId)?.id === transaction.id) waitingSaves.delete(noteId);
          touch();
        }
      },
      createNote: async ({ transaction }) => {
        const input = transaction.metadata as unknown as Parameters<typeof api.createNote>[0];
        try {
          const created = await api.createNote(input).catch(refusal);
          if (!took(created)) await settled();
          ended(transaction.id);
        } catch (err) {
          ended(transaction.id, err);
          throw err;
        } finally {
          touch();
        }
      },
      duplicateNote: async ({ transaction }) => {
        const { sourceId, copyId } = transaction.metadata as unknown as { sourceId: string; copyId: string };
        try {
          const copy = await api.duplicateNote(sourceId, copyId).catch(refusal);
          // The copy's row goes in now; its files are the server's to make, and the
          // pull brings their rows.
          took(copy);
          await settled();
          ended(transaction.id);
        } catch (err) {
          ended(transaction.id, err);
          throw err;
        } finally {
          touch();
        }
      },
      // Trash, restore and purge: an id the server no longer has is done, not an error.
      trashNote: async ({ transaction }) => run(transaction.id, () => api.deleteNote(id(transaction)).catch(gone)),
      restoreNote: async ({ transaction }) => run(transaction.id, () => api.restoreNote(id(transaction)).then(() => undefined, gone)),
      purgeNote: async ({ transaction }) => run(transaction.id, () => api.deleteNotePermanently(id(transaction)).catch(gone)),
      trashNotes: async ({ transaction }) => run(transaction.id, () => api.deleteNotes(ids(transaction)).then(() => undefined, refusal)),
      restoreNotes: async ({ transaction }) => run(transaction.id, () => api.restoreNotes(ids(transaction)).then(() => undefined, refusal)),
      purgeNotes: async ({ transaction }) => run(transaction.id, () => api.deleteNotesPermanently(ids(transaction)).then(() => undefined, refusal)),
      moveNotes: async ({ transaction }) => {
        const { ids: which, notebook } = transaction.metadata as unknown as { ids: string[]; notebook: string | null };
        return run(transaction.id, () => api.updateNotes(which, { notebook }).then(() => undefined, refusal));
      },
      tagNotes: async ({ transaction }) => {
        const { ids: which, add, remove } = transaction.metadata as unknown as { ids: string[]; add?: string[]; remove?: string[] };
        return run(transaction.id, () => api.updateNotes(which, { addTags: add, removeTags: remove }).then(() => undefined, refusal));
      },
    },
  });

  const id = (t: Transaction) => (t.metadata as { noteId: string }).noteId;
  const ids = (t: Transaction) => (t.metadata as { ids: string[] }).ids;
  const gone = (err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return;
    refusal(err);
  };
  async function run(entryId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      await settled();
      ended(entryId);
    } catch (err) {
      ended(entryId, err);
      throw err;
    } finally {
      touch();
    }
  }
  /**
   * The server's copy, written into the row before the entry ends. Ending an entry drops
   * the optimistic change, and what the row showed then was the last copy the feed had
   * delivered — the one from before the write — until a pull landed: a flash of the old
   * title in the list, and once the workspace taking the old copy for a change of
   * theirs (review of #232). The answer to a write is that copy, so it goes straight in,
   * as a feed row — tags and notebook by id, looked up by the names the answer carries,
   * and the files the note holds — and no request follows. False when a name has no id
   * here yet (a tag made by this very write), and the pull brings the ids instead.
   */
  const took = (note: Note): boolean => {
    const l = lookups(snapshot(lib));
    const tagIdByName = new Map([...l.tags.values()].map((t) => [t.name, t.id]));
    const notebookIdByName = new Map([...l.notebooks.values()].map((n) => [n.name, n.id]));
    const tagIds: string[] = [];
    for (const name of note.tags) {
      const id = tagIdByName.get(name);
      if (!id) return false;
      tagIds.push(id);
    }
    const notebookId = note.notebook == null ? null : (notebookIdByName.get(note.notebook) ?? false);
    if (notebookId === false) return false;
    const { tags: _tags, notebook: _notebook, ...rest } = note;
    const row: FeedNote = { ...rest, tagIds, notebookId, files: l.filesByNote.get(note.id) ?? [] };
    return lib.engine.applyNotes([row]);
  };

  /**
   * When the answer could not be written in: the copy, brought here by a pull before the
   * entry ends. `pull` never rejects and waits out a queued second run.
   *
   * Not during the first copy. A pull then is the whole snapshot walk — minutes on a
   * phone — and an entry that waited for it held the queue behind it, kept "syncing" up
   * and timed a sign-out's drain out (review of #232). The walk ends by following the
   * feed from the `seq` it began at, which carries this write too; the pull is asked for
   * so a walk already over picks it up, and not waited for.
   */
  const settled = () => {
    if (lib.engine.state.phase !== 'hydrating') return lib.engine.pull();
    void lib.engine.pull();
    return Promise.resolve();
  };

  const unsubscribeConnectivity = subscribeConnectivity(touch);
  // The saves a reload restored, so a new save of one of their notes retires them too;
  // and the conflicts still waiting on a choice.
  const ready = executor
    .waitForInit()
    .then(() => Promise.all([executor.peekOutbox(), storage.keys()]))
    .then(async ([entries, keys]) => {
      for (const t of entries) {
        entryNotes.set(t.id, notesOf(t.metadata as Record<string, unknown> | undefined));
        if (t.mutationFnName !== 'saveNote') continue;
        const m = t.metadata as Save | undefined;
        /*
         * A restored entry's change on the row is the executor's own restoration
         * transaction, which it rolls back itself only when the entry ends. Retired
         * offline, that is whenever the connection returns, and the row would show the
         * retired text the whole while (review of #232) — so the restoration is rolled
         * back here, through the executor's private cleanup. The version is pinned
         * (`pins.test.ts`); without the method the change stays until the entry's turn.
         */
        const cleanup = (executor as unknown as { cleanupRestorationTransaction?: (id: string, rollback: boolean) => void }).cleanupRestorationTransaction;
        if (m && !waitingSaves.has(m.noteId)) waitingSaves.set(m.noteId, { id: t.id, base: m.base, against: m.against, retire: () => cleanup?.call(executor, t.id, true) });
      }
      for (const key of keys) {
        if (!key.startsWith('conflict:')) continue;
        const raw = await storage.get(key);
        if (raw) conflicts.set(key.slice('conflict:'.length), JSON.parse(raw) as Conflict);
      }
      if (conflicts.size > 0 || entryNotes.size > 0) touch();
    })
    .catch(() => {});
  return {
    executor,
    ready,
    status,
    subscribe: (l) => {
      listeners.add(l);
      l(status());
      return () => void listeners.delete(l);
    },
    onAcknowledged: (l) => {
      acks.add(l);
      return () => void acks.delete(l);
    },
    resolveConflict: (noteId) => {
      if (!conflicts.delete(noteId)) return;
      void storage.delete(conflictKey(noteId)).catch(() => {});
      touch();
    },
    supersedeSave: (noteId) => {
      const waiting = waitingSaves.get(noteId);
      if (!waiting) return null;
      waitingSaves.delete(noteId);
      superseded.add(waiting.id);
      // Out of storage now, so a reload restores only the save that counts; the
      // scheduler still holds it, and it ends quietly when its turn comes. Its change
      // comes off the row now rather than then: offline, "then" is whenever the
      // connection returns, and the row would show the retired text the whole while.
      void executor.removeFromOutbox(waiting.id).catch(() => {});
      waiting.retire();
      return { base: waiting.base, against: waiting.against };
    },
    trackSave: (noteId, entry) => {
      waitingSaves.set(noteId, entry);
    },
    trackEntry: (id, noteIds) => {
      entryNotes.set(id, noteIds);
      touch();
    },
    dispose: async () => {
      unsubscribeConnectivity();
      executor.dispose();
      /*
       * The adapter opens its database once and never closes it, and a `deleteDatabase`
       * on a database something holds open waits for ever: the wipe on sign-out would
       * remove the store's file and leave the outbox, named with the account's id, behind
       * (seen on 2026-10-02). The connection is the adapter's private field; closed here,
       * once, after the executor has stopped. A pinned version; the fallback is a database
       * left behind, which holds no rows after `dispose` and is removed on the next wipe.
       */
      (adapter as unknown as { db?: IDBDatabase | null }).db?.close?.();
    },
  };
}

/**
 * The outbox's storage, watched. Every entry passes through the adapter — stored when
 * queued, restored after a reload, removed when a replay settles — so counting the keys it
 * holds is what waits for the server, at every moment. The executor's own count is its
 * scheduler's, which learns of an entry only after it is stored and settles it only by
 * replaying it: a write made offline was stored and then waited, counted as nothing, and
 * the head said "Saved" for a write the server had not heard of (review of #232). The
 * entries are the `tx:` keys; the one marker the executor writes beside a settling entry
 * is an update of the same key.
 */
function watched(inner: StorageAdapter, onChange: () => void): StorageAdapter & { held: () => number } {
  const keys = new Set<string>();
  const entry = (key: string) => key.startsWith('tx:');
  const changed = () => onChange();
  return {
    get: (key) => inner.get(key),
    set: async (key, value) => {
      await inner.set(key, value);
      if (entry(key)) {
        keys.add(key);
        changed();
      }
    },
    delete: async (key) => {
      await inner.delete(key);
      if (keys.delete(key)) changed();
    },
    keys: async () => {
      const all = await inner.keys();
      keys.clear();
      for (const k of all) if (entry(k)) keys.add(k);
      changed();
      return all;
    },
    clear: async () => {
      await inner.clear();
      keys.clear();
      changed();
    },
    held: () => keys.size,
  };
}

/** The notes an entry is about, from what it carries: one note, several, or the one it makes. */
function notesOf(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  if (Array.isArray(metadata.ids)) return metadata.ids as string[];
  for (const key of ['noteId', 'copyId', 'id']) if (typeof metadata[key] === 'string') return [metadata[key] as string];
  return [];
}

/** `connectivity.ts` is the one thing that decides whether the app is offline; the executor follows it. */
function connectivityDetector(): OnlineDetector {
  return {
    subscribe: (cb) =>
      subscribeConnectivity(() => {
        if (!offlineNow()) cb();
      }),
    notifyOnline: () => recheck(),
    isOnline: () => !offlineNow(),
    dispose: () => {},
  };
}

function snapshot(lib: Collections): Snapshot {
  return { notes: lib.notes.values(), notebooks: lib.notebooks.values(), tags: lib.tags.values(), attachments: lib.attachments.values() };
}

// --- The actions ----------------------------------------------------------------------

let resolve: () => Promise<WritableLibrary | null> = async () => null;

/** How the actions find the open library; set by `store/library.ts`. */
export function provideLibrary(fn: () => Promise<WritableLibrary | null>): void {
  resolve = fn;
}

/** Whether a write made here goes to the outbox and outlives the tab; see the module comment. */
const durable = (lib: WritableLibrary) => lib.outbox.executor.isOfflineEnabled;

/**
 * The library a write may be queued on: the open one, if this tab holds the outbox's
 * lock; else null, and the write is a request. Every action starts here.
 */
async function queueable(): Promise<WritableLibrary | null> {
  const lib = await resolve();
  return lib && durable(lib) ? lib : null;
}

const directListeners = new Set<() => void>();

/**
 * Hears every write made as a request rather than queued: on a device with no library,
 * and in a tab that does not hold the outbox. The queries follow the library when there
 * is one; with none, nothing else tells the list that a note was trashed or a title
 * changed, so the query bridge listens here as well and refetches what a write reaches
 * (review of #232, where the list kept a trashed note on such a device).
 */
export function onDirectWrite(listener: () => void): () => void {
  directListeners.add(listener);
  return () => void directListeners.delete(listener);
}

/**
 * After a write made as a request: whoever follows direct writes hears of it, and in a
 * tab that has a library but does not queue, the server's copy is brought to the local
 * copy now rather than on the next nudge, so the row on screen agrees with the answer.
 * Nothing to wait for; the library is already right about every row this did not touch.
 */
async function pulled<T>(write: Promise<T>): Promise<T> {
  const out = await write;
  directListeners.forEach((l) => l());
  const lib = await resolve();
  if (lib) void lib.engine.pull();
  return out;
}

/**
 * Queues one write: the optimistic change on the row, then the entry in the outbox. The
 * commit is not awaited — it settles when the server has answered, which offline is
 * whenever the connection returns — but its failure is heard, since an entry the outbox
 * could not store is a change that will be lost on reload.
 */
function queue(lib: WritableLibrary, mutationFnName: string, metadata: Record<string, unknown>, mutate: () => void): { id: string; retire: () => void } {
  if (!durable(lib)) throw new Error('queue() in a tab that does not hold the outbox'); // callers go through queueable()
  const tx = lib.outbox.executor.createOfflineTransaction({ mutationFnName, autoCommit: false, metadata });
  const inner = tx.mutate(mutate);
  void tx.commit().catch((err: unknown) => {
    if (err instanceof NonRetriableError) return; // reported where it was raised
    console.error(`[outbox] ${mutationFnName} could not be queued:`, err);
  });
  lib.outbox.trackEntry(tx.id, notesOf(metadata));
  return {
    id: tx.id,
    /*
     * Takes the change off the row while the entry still waits. A secondary rollback, so
     * TanStack DB does not also roll back every later transaction on the same row — a
     * trash or a move queued after this save are their own entries and stand. A
     * transaction that has already ended has nothing to take off.
     */
    retire: () => {
      try {
        inner.rollback({ isSecondaryRollback: true });
      } catch {
        // Already completed.
      }
    },
  };
}

/** A draft's values as the row holds them: named from the definitions held, and only the storeable ones. */
function valuesOf(value: NoteDraft, lib: WritableLibrary): NoteFieldValue[] {
  const l = lookups(snapshot(lib));
  const out: NoteFieldValue[] = [];
  for (const [fieldId, v] of Object.entries(value.fields)) {
    if (v === null || v === undefined) continue;
    const def = l.fieldDefs.get(fieldId);
    if (!def) continue;
    out.push({ fieldId, name: def.name, type: def.type, value: v, scale: def.scale, currency: def.currency, notebookId: def.notebookId, notebook: l.notebooks.get(def.notebookId)?.name ?? '' });
  }
  return out;
}

/**
 * Saves a draft of a note against the copy the draft was made from. Resolves once the
 * change is on the local copy and in the outbox — "saved" on this device — with
 * `'unchanged'` when the draft differs from its base in nothing the server can hold.
 * The server's answer arrives later: through `onAcknowledged` when it took the save, in
 * `conflicts` when it refused one and the person has to choose.
 */
export async function saveNote(input: Save): Promise<'queued' | 'unchanged' | Note> {
  const lib = await queueable();
  if (!lib) {
    // No local copy on this device, or a tab that does not queue: the save is the
    // request, and its answer is the server's copy — or the refusal, which the caller
    // puts to the person.
    const patch = buildNotePatch(input.value, input.base, undefined);
    if (!patch) return 'unchanged';
    return pulled(
      (async () => {
        try {
          return await api.updateNote(input.noteId, { ...patch, ifUpdatedAt: input.against ?? input.base.updatedAt });
        } catch (err) {
          if (!isNoteChanged(err) || input.against !== undefined || !holdsTheirChanges(input.value, input.base, err.current)) throw err;
          return api.updateNote(input.noteId, { ...patch, ifUpdatedAt: err.current.updatedAt });
        }
      })(),
    );
  }
  /*
   * One save per note in the queue. The one still waiting is retired first, and this one
   * takes over what it carried: its base when older — the copy the typing started from,
   * so the patch and the precondition are made against the server's copy, not a later
   * local one — and its "Keep mine" date, so a keystroke after the choice does not undo
   * it. The patch is made against that base, and only then: a draft typed back to what
   * the server holds has nothing to send, and retiring the waiting save is the revert.
   * Deciding "nothing to send" first, against the newer base, left the retired save in
   * the queue to write the undone text (review of #232).
   */
  const carried = lib.outbox.supersedeSave(input.noteId);
  const base = carried && carried.base.updatedAt < input.base.updatedAt ? carried.base : input.base;
  const patch = buildNotePatch(input.value, base, [...lookups(snapshot(lib)).fieldDefs.values()]);
  if (!patch) return 'unchanged';
  const { value } = input;
  const entry: Save = { noteId: input.noteId, value, base, against: input.against ?? carried?.against };
  const queued = queue(lib, 'saveNote', entry as unknown as Record<string, unknown>, () => {
    lib.notes.update(input.noteId, (row) => {
      if (patch.title !== undefined) row.title = value.title;
      if (patch.body !== undefined) row.body = value.body;
      if (patch.tags !== undefined) row.tagNames = value.tags;
      if (patch.notebook !== undefined) row.notebookName = value.notebook;
      if (patch.fields !== undefined) row.fields = valuesOf(value, lib);
    });
  });
  lib.outbox.trackSave(input.noteId, { ...queued, base, against: entry.against });
  return 'queued';
}

/** Makes a note, with an id minted here, and answers with it at once. */
export async function createNote(input: { title: string; body: string; tags: string[]; notebook: string | null }): Promise<Note> {
  const lib = await queueable();
  if (!lib) return pulled(api.createNote(input));
  const id = crypto.randomUUID();
  const now = Date.now();
  const row: LocalNote = { id, title: input.title, body: input.body, createdAt: now, updatedAt: now, tagIds: [], tagNames: input.tags, notebookId: null, notebookName: input.notebook, files: [] };
  queue(lib, 'createNote', { id, ...input }, () => {
    lib.notes.insert(row);
  });
  return toNote(row, lookups(snapshot(lib)));
}

/** A copy of a note, under an id minted here; the server copies its files. */
export async function duplicateNote(sourceId: string): Promise<{ id: string }> {
  const lib = await queueable();
  if (!lib) return pulled(api.duplicateNote(sourceId));
  const source = lib.notes.get(sourceId);
  if (!source) return pulled(api.duplicateNote(sourceId));
  const copyId = crypto.randomUUID();
  const now = Date.now();
  queue(lib, 'duplicateNote', { sourceId, copyId }, () => {
    lib.notes.insert({ ...source, id: copyId, createdAt: now, updatedAt: now, files: [] });
  });
  return { id: copyId };
}

export async function trashNote(noteId: string): Promise<void> {
  const lib = await queueable();
  if (!lib) return pulled(api.deleteNote(noteId));
  queue(lib, 'trashNote', { noteId }, () => {
    lib.notes.update(noteId, (row) => {
      row.deletedAt = Date.now();
    });
  });
}

export async function restoreNote(noteId: string): Promise<void> {
  const lib = await queueable();
  if (!lib) return pulled(api.restoreNote(noteId).then(() => undefined));
  queue(lib, 'restoreNote', { noteId }, () => {
    lib.notes.update(noteId, (row) => {
      delete row.deletedAt;
    });
  });
}

export async function purgeNote(noteId: string): Promise<void> {
  const lib = await queueable();
  if (!lib) return pulled(api.deleteNotePermanently(noteId));
  queue(lib, 'purgeNote', { noteId }, () => {
    lib.notes.delete(noteId);
  });
}

const held = (lib: WritableLibrary, ids: string[]) => ids.filter((id) => lib.notes.has(id));

/*
 * The bulk verbs answer with how many notes they acted on: the notes held here, since
 * the server's count comes later from the queue, or the server's count when the write
 * was a request. What the message after the action names.
 */

export async function trashNotes(ids: string[]): Promise<number> {
  const lib = await queueable();
  if (!lib) return pulled(api.deleteNotes(ids).then((r) => r.trashed));
  const which = held(lib, ids);
  if (which.length === 0) return 0;
  queue(lib, 'trashNotes', { ids: which }, () => {
    const now = Date.now();
    for (const id of which) lib.notes.update(id, (row) => void (row.deletedAt = now));
  });
  return which.length;
}

export async function restoreNotes(ids: string[]): Promise<number> {
  const lib = await queueable();
  if (!lib) return pulled(api.restoreNotes(ids).then((r) => r.restored));
  const which = held(lib, ids);
  if (which.length === 0) return 0;
  queue(lib, 'restoreNotes', { ids: which }, () => {
    for (const id of which) lib.notes.update(id, (row) => void delete row.deletedAt);
  });
  return which.length;
}

export async function purgeNotes(ids: string[]): Promise<number> {
  const lib = await queueable();
  if (!lib) return pulled(api.deleteNotesPermanently(ids).then((r) => r.deleted));
  const which = held(lib, ids);
  if (which.length === 0) return 0;
  queue(lib, 'purgeNotes', { ids: which }, () => {
    for (const id of which) lib.notes.delete(id);
  });
  return which.length;
}

export async function moveNotes(ids: string[], notebook: string | null): Promise<void> {
  const lib = await queueable();
  if (!lib) return pulled(api.updateNotes(ids, { notebook }).then(() => undefined));
  const which = held(lib, ids);
  if (which.length === 0) return;
  queue(lib, 'moveNotes', { ids: which, notebook }, () => {
    for (const id of which) lib.notes.update(id, (row) => void (row.notebookName = notebook));
  });
}

export async function tagNotes(ids: string[], change: { add?: string[]; remove?: string[] }): Promise<void> {
  const lib = await queueable();
  if (!lib) return pulled(api.updateNotes(ids, { addTags: change.add, removeTags: change.remove }).then(() => undefined));
  const which = held(lib, ids);
  if (which.length === 0) return;
  const l = lookups(snapshot(lib));
  const add = change.add ?? [];
  const remove = new Set(change.remove ?? []);
  queue(lib, 'tagNotes', { ids: which, ...change }, () => {
    for (const id of which) {
      lib.notes.update(id, (row) => {
        const current = row.tagNames ?? row.tagIds.map((t) => l.tags.get(t)?.name).filter((n): n is string => !!n);
        row.tagNames = [...current.filter((t) => !remove.has(t)), ...add.filter((t) => !current.includes(t))];
      });
    }
  });
}

/**
 * The row as the server last had it, under whatever writes are pending here. A save's
 * base must be that copy, not the optimistic one: the precondition names the server's
 * date, and `holdsTheirChanges` compares against the server's text. The collection
 * keeps the two apart but exposes only the merged view, so this reads its state
 * manager; the version is pinned, and the fallback is the merged view.
 */
function syncedRow(lib: WritableLibrary, noteId: string): LocalNote | undefined {
  const state = (lib.notes as unknown as { _state?: { syncedData?: Map<string, LocalNote> } })._state;
  return state?.syncedData?.get(noteId) ?? lib.notes.get(noteId);
}

/**
 * One field of a note, from the table beside the list: a save of the note's draft with
 * that value changed, queued like any other, answering with the note as it now shows.
 */
export async function setNoteField(noteId: string, def: FieldDef, value: FieldValue | null): Promise<Note> {
  const lib = await queueable();
  const row = lib ? syncedRow(lib, noteId) : undefined;
  if (!lib || !row) return pulled(api.updateNote(noteId, { fields: { [def.id]: value } }));
  const l = lookups(snapshot(lib));
  const base = toNote(row, l);
  const shown = toNote(lib.notes.get(noteId) ?? row, l);
  const value_ = { ...seedFrom(shown), fields: { ...seedFrom(shown).fields, [def.id]: value } };
  await saveNote({ noteId, value: value_, base });
  return toNote(lib.notes.get(noteId) ?? row, lookups(snapshot(lib)));
}

import { IndexedDBAdapter, NonRetriableError, startOfflineExecutor, type OfflineExecutor, type OnlineDetector, type StorageAdapter } from '@tanstack/offline-transactions';
import type { Transaction } from '@tanstack/db';
import type { FieldDef, FieldValue, Note, NoteFieldValue } from '@unbent/shared';
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
 * entry at a time, with a growing wait between attempts; only the tab that holds the
 * lock replays, and a second tab's writes made offline are not durable. Two rules keep
 * the queue from sticking: every answer the server will give again gets
 * `NonRetriableError` — a 4xx, a refused precondition — so the entries behind it move,
 * and a `saveNote` whose note has a later entry in the queue does nothing when its turn
 * comes, since each save carries the whole draft and the one after subsumes it. A lost
 * connection and a 5xx are retried.
 *
 * Every function here looks the open library up and works on it; with none — a browser
 * without the file system the local copy lives in — it does what the app did before,
 * one request, and the answer is the server's.
 */

/** A conflict waiting on a choice: the note as the server now holds it. */
export interface SyncStatus {
  /** Writes made here the server has not yet accepted. */
  pending: number;
  /**
   * Whether a write queued in this tab outlives it. Only the tab holding the outbox's lock
   * stores entries; in any other tab a write is a request made at once, and offline it
   * fails as one (see `durable` below).
   */
  durable: boolean;
  conflicts: ReadonlyMap<string, Note>;
}

export interface Outbox {
  executor: OfflineExecutor;
  status: () => SyncStatus;
  subscribe: (listener: (status: SyncStatus) => void) => () => void;
  /** Hears the server's copy after a replayed save of that note went through. */
  onAcknowledged: (listener: (noteId: string, note: Note) => void) => () => void;
  /** Forgets a conflict once a choice has been made. */
  resolveConflict: (noteId: string) => void;
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

export function createOutbox(userId: string, lib: Omit<WritableLibrary, 'outbox'>): Outbox {
  const conflicts = new Map<string, Note>();
  const listeners = new Set<(s: SyncStatus) => void>();
  const acks = new Set<(id: string, note: Note) => void>();
  const status = (): SyncStatus => ({ pending: storage.held(), durable: executor.isOfflineEnabled, conflicts });
  const touch = () => {
    const s = status();
    listeners.forEach((l) => l(s));
  };

  const defs = (): FieldDef[] => [...lookups(snapshot(lib)).fieldDefs.values()];

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
          const later = (await executor.peekOutbox()).some(
            (t) => t.mutationFnName === 'saveNote' && (t.metadata as Save | undefined)?.noteId === noteId && t.createdAt > transaction.createdAt,
          );
          if (later) return;
          const patch = buildNotePatch(value, base, defs());
          if (!patch) return;
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
              conflicts.set(noteId, err.current);
              await lib.engine.pull();
              throw new NonRetriableError(`Note ${noteId} changed on another device`);
            }
            try {
              updated = await api.updateNote(noteId, { ...patch, ifUpdatedAt: err.current.updatedAt });
            } catch (again) {
              if (!isNoteChanged(again)) return refusal(again);
              conflicts.set(noteId, again.current);
              await lib.engine.pull();
              throw new NonRetriableError(`Note ${noteId} changed on another device`);
            }
          }
          acks.forEach((l) => l(noteId, updated));
          await settled();
        } finally {
          touch();
        }
      },
      createNote: async ({ transaction }) => {
        const input = transaction.metadata as unknown as Parameters<typeof api.createNote>[0];
        try {
          await api.createNote(input).catch(refusal);
          await settled();
        } finally {
          touch();
        }
      },
      duplicateNote: async ({ transaction }) => {
        const { sourceId, copyId } = transaction.metadata as unknown as { sourceId: string; copyId: string };
        try {
          await api.duplicateNote(sourceId, copyId).catch(refusal);
          await settled();
        } finally {
          touch();
        }
      },
      // Trash, restore and purge: an id the server no longer has is done, not an error.
      trashNote: async ({ transaction }) => run(() => api.deleteNote(id(transaction)).catch(gone)),
      restoreNote: async ({ transaction }) => run(() => api.restoreNote(id(transaction)).then(() => undefined, gone)),
      purgeNote: async ({ transaction }) => run(() => api.deleteNotePermanently(id(transaction)).catch(gone)),
      trashNotes: async ({ transaction }) => run(() => api.deleteNotes(ids(transaction)).then(() => undefined, refusal)),
      restoreNotes: async ({ transaction }) => run(() => api.restoreNotes(ids(transaction)).then(() => undefined, refusal)),
      purgeNotes: async ({ transaction }) => run(() => api.deleteNotesPermanently(ids(transaction)).then(() => undefined, refusal)),
      moveNotes: async ({ transaction }) => {
        const { ids: which, notebook } = transaction.metadata as unknown as { ids: string[]; notebook: string | null };
        return run(() => api.updateNotes(which, { notebook }).then(() => undefined, refusal));
      },
      tagNotes: async ({ transaction }) => {
        const { ids: which, add, remove } = transaction.metadata as unknown as { ids: string[]; add?: string[]; remove?: string[] };
        return run(() => api.updateNotes(which, { addTags: add, removeTags: remove }).then(() => undefined, refusal));
      },
    },
  });

  const id = (t: Transaction) => (t.metadata as { noteId: string }).noteId;
  const ids = (t: Transaction) => (t.metadata as { ids: string[] }).ids;
  const gone = (err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return;
    refusal(err);
  };
  async function run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      await settled();
    } finally {
      touch();
    }
  }
  /**
   * After the server took a write: its copy, brought here before the entry ends. Ending
   * an entry drops the optimistic change from the row, and what the row shows then is
   * the last copy the feed delivered — the one from before the write — until the pull
   * lands. Left to run on its own (seen in review, 2026-10-02) that window flashed the old
   * title in the list, and the workspace took the old copy for a change of theirs and
   * reseeded the editor with it. `pull` never rejects and waits out a queued second run.
   */
  const settled = () => lib.engine.pull();

  const unsubscribeConnectivity = subscribeConnectivity(touch);
  return {
    executor,
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
      if (conflicts.delete(noteId)) touch();
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

/**
 * Queues one write: the optimistic change on the row, then the entry in the outbox. The
 * commit is not awaited — it settles when the server has answered, which offline is
 * whenever the connection returns — but its failure is heard, since an entry the outbox
 * could not store is a change that will be lost on reload.
 */
function queue(lib: WritableLibrary, mutationFnName: string, metadata: Record<string, unknown>, mutate: () => void): void {
  const tx = lib.outbox.executor.createOfflineTransaction({ mutationFnName, autoCommit: false, metadata });
  tx.mutate(mutate);
  void tx.commit().catch((err: unknown) => {
    if (err instanceof NonRetriableError) return; // reported where it was raised
    console.error(`[outbox] ${mutationFnName} could not be queued:`, err);
  });
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
  const lib = await resolve();
  if (!lib) {
    // No local copy on this device: the save is the request, and its answer is the
    // server's copy — or the refusal, which the caller puts to the person.
    const patch = buildNotePatch(input.value, input.base, undefined);
    if (!patch) return 'unchanged';
    try {
      return await api.updateNote(input.noteId, { ...patch, ifUpdatedAt: input.against ?? input.base.updatedAt });
    } catch (err) {
      if (!isNoteChanged(err) || input.against !== undefined || !holdsTheirChanges(input.value, input.base, err.current)) throw err;
      return api.updateNote(input.noteId, { ...patch, ifUpdatedAt: err.current.updatedAt });
    }
  }
  const patch = buildNotePatch(input.value, input.base, [...lookups(snapshot(lib)).fieldDefs.values()]);
  if (!patch) return 'unchanged';
  const { value } = input;
  queue(lib, 'saveNote', input as unknown as Record<string, unknown>, () => {
    lib.notes.update(input.noteId, (row) => {
      if (patch.title !== undefined) row.title = value.title;
      if (patch.body !== undefined) row.body = value.body;
      if (patch.tags !== undefined) row.tagNames = value.tags;
      if (patch.notebook !== undefined) row.notebookName = value.notebook;
      if (patch.fields !== undefined) row.fields = valuesOf(value, lib);
    });
  });
  return 'queued';
}

/** Makes a note, with an id minted here, and answers with it at once. */
export async function createNote(input: { title: string; body: string; tags: string[]; notebook: string | null }): Promise<Note> {
  const lib = await resolve();
  if (!lib) return api.createNote(input);
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
  const lib = await resolve();
  if (!lib) return api.duplicateNote(sourceId);
  const source = lib.notes.get(sourceId);
  if (!source) return api.duplicateNote(sourceId);
  const copyId = crypto.randomUUID();
  const now = Date.now();
  queue(lib, 'duplicateNote', { sourceId, copyId }, () => {
    lib.notes.insert({ ...source, id: copyId, createdAt: now, updatedAt: now, files: [] });
  });
  return { id: copyId };
}

export async function trashNote(noteId: string): Promise<void> {
  const lib = await resolve();
  if (!lib) return api.deleteNote(noteId);
  queue(lib, 'trashNote', { noteId }, () => {
    lib.notes.update(noteId, (row) => {
      row.deletedAt = Date.now();
    });
  });
}

export async function restoreNote(noteId: string): Promise<void> {
  const lib = await resolve();
  if (!lib) return api.restoreNote(noteId).then(() => undefined);
  queue(lib, 'restoreNote', { noteId }, () => {
    lib.notes.update(noteId, (row) => {
      delete row.deletedAt;
    });
  });
}

export async function purgeNote(noteId: string): Promise<void> {
  const lib = await resolve();
  if (!lib) return api.deleteNotePermanently(noteId);
  queue(lib, 'purgeNote', { noteId }, () => {
    lib.notes.delete(noteId);
  });
}

const held = (lib: WritableLibrary, ids: string[]) => ids.filter((id) => lib.notes.has(id));

export async function trashNotes(ids: string[]): Promise<void> {
  const lib = await resolve();
  if (!lib) return api.deleteNotes(ids).then(() => undefined);
  const which = held(lib, ids);
  if (which.length === 0) return;
  queue(lib, 'trashNotes', { ids: which }, () => {
    const now = Date.now();
    for (const id of which) lib.notes.update(id, (row) => void (row.deletedAt = now));
  });
}

export async function restoreNotes(ids: string[]): Promise<void> {
  const lib = await resolve();
  if (!lib) return api.restoreNotes(ids).then(() => undefined);
  const which = held(lib, ids);
  if (which.length === 0) return;
  queue(lib, 'restoreNotes', { ids: which }, () => {
    for (const id of which) lib.notes.update(id, (row) => void delete row.deletedAt);
  });
}

export async function purgeNotes(ids: string[]): Promise<void> {
  const lib = await resolve();
  if (!lib) return api.deleteNotesPermanently(ids).then(() => undefined);
  const which = held(lib, ids);
  if (which.length === 0) return;
  queue(lib, 'purgeNotes', { ids: which }, () => {
    for (const id of which) lib.notes.delete(id);
  });
}

export async function moveNotes(ids: string[], notebook: string | null): Promise<void> {
  const lib = await resolve();
  if (!lib) return api.updateNotes(ids, { notebook }).then(() => undefined);
  const which = held(lib, ids);
  if (which.length === 0) return;
  queue(lib, 'moveNotes', { ids: which, notebook }, () => {
    for (const id of which) lib.notes.update(id, (row) => void (row.notebookName = notebook));
  });
}

export async function tagNotes(ids: string[], change: { add?: string[]; remove?: string[] }): Promise<void> {
  const lib = await resolve();
  if (!lib) return api.updateNotes(ids, { addTags: change.add, removeTags: change.remove }).then(() => undefined);
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
  const lib = await resolve();
  const row = lib ? syncedRow(lib, noteId) : undefined;
  if (!lib || !row) return api.updateNote(noteId, { fields: { [def.id]: value } });
  const l = lookups(snapshot(lib));
  const base = toNote(row, l);
  const shown = toNote(lib.notes.get(noteId) ?? row, l);
  const value_ = { ...seedFrom(shown), fields: { ...seedFrom(shown).fields, [def.id]: value } };
  await saveNote({ noteId, value: value_, base });
  return toNote(lib.notes.get(noteId) ?? row, lookups(snapshot(lib)));
}

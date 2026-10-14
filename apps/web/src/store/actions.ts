import { IndexedDBAdapter, NonRetriableError, startOfflineExecutor, type OfflineExecutor, type OnlineDetector, type StorageAdapter } from '@tanstack/offline-transactions';
import type { Transaction } from '@tanstack/db';
import { MAX_ATTACHMENT_BYTES, filenameSchema, foldNoCase, type FeedNote, type FieldDef, type FieldValue, type Note, type NoteFieldValue, type NotebookDefinition, type RestoredNote } from '@unbent/shared';
import * as api from '../notes-api.js';
import { ApiError, isNoteChanged, isOfflineError, NoteChangedError } from '../notes-api.js';
import { offlineNow, recheck, subscribeConnectivity } from '../connectivity.js';
import { buildNotePatch, seedFrom, holdsTheirChanges, rebaseAfterAck, type NoteDraft } from '../note-patch.js';
import { availableFilename, lookups, toNote, type Snapshot } from './derive.js';
import type { Collections, LocalNote } from './collections.js';
import { askToPersist, filesSupported, readFile, removeFile, writeFile } from './files.js';
import { FILES_CACHE, FILES_CHANGED, MAX_KEPT_FILE } from '../sw/routes.js';
import { isWhole, refusedForGood, type FeedEngine } from './feed.js';
import { CallUnsettledError, LibraryMovedError, SEND_ONCE } from './client-library.js';
import { outboxLeaderName, outboxName } from './names.js';
import { OutboxLeader } from './leader.js';

/**
 * Writes to notes: made on the local copy at once and replayed to the server through a
 * durable outbox, so a note can be edited, made, trashed or restored with no connection
 * and the server hears of it when there is one.
 *
 * A file added to a note with no connection goes this way too (`uploadFile`): its bytes
 * to the account's `pending` shelf, a row for it at once, and its upload an entry here,
 * behind whatever its note already has waiting.
 *
 * Otherwise only note writes go this way. Notebook, tag and field management — renames, merges,
 * deletes, field definitions, option removal, conversions — are settings-page actions
 * with uniqueness and conversion rules the server decides, and stay direct calls that
 * need a connection; the feed delivers what they did to every device.
 *
 * The outbox (`@tanstack/offline-transactions`) is one queue, replayed in order, one
 * entry at a time, with a growing wait between attempts. Two rules keep the queue from
 * sticking: every answer the server will give again gets `NonRetriableError` — a 4xx
 * that will not change on retry (a name it will not take, a file too large, a note that
 * is gone), a refused precondition — so the entries behind it move, and the outbox holds
 * at most one save per note. A lapsed session, a timeout and a rate limit are not that:
 * they become a different answer after sign-in or a wait, and ending the entry on them
 * deletes the only copy of an offline upload, or a save typed while the session was
 * still good. Each save carries the whole draft, so a new save of a note supersedes the
 * one still waiting: the waiting entry is removed from storage when the new one is queued
 * and does nothing when its turn comes, and the new one carries the older base forward.
 * An hour of autosaves offline is one entry and one PATCH, not thousands of copies of the
 * body collapsed at replay by reading the whole queue per entry (review of #232). A lost
 * connection and a 5xx are retried.
 *
 * Only the tab holding the outbox's lock queues. A tab whose library another tab holds
 * is that tab's client and sends each write there by name (`away`), where it is queued
 * as the holder's own. In a tab that holds the library but not yet the outbox's lock —
 * a moment during a hand-over, or for good in a browser without Web Locks — the
 * library hands back a plain transaction that runs the write at once and rolls the
 * change back if it fails, and offline it fails — so such a tab's writes are not
 * "queued", they are never made, and saying otherwise would show "Saved" over text that
 * was gone (review of #232). Every function here therefore asks `durable` first, and in
 * a tab that is not it does what it does with no library at all: one request, the
 * answer the server's, the refusal the caller's to show, and the local copy brought up
 * to date by a pull.
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
   * stores entries; in a client tab this is the holder's answer, mirrored, since its
   * writes are queued there; in a tab that holds the library but not the lock a write
   * is a request made at once, and offline it fails as one (see `durable` below).
   */
  durable: boolean;
  /**
   * The notes with an entry waiting: what the note head marks with a glyph, so a note
   * that is only on this device can be told from one the server has. Online that is the
   * half second a replay takes; offline it is the whole stretch.
   */
  waiting: ReadonlySet<string>;
  conflicts: ReadonlyMap<string, Conflict>;
  /**
   * What became of uploads that did not simply go through, by note, until dismissed: a
   * file the server refused for good, or one it stored under another name. An upload made
   * with a connection fails where it was dropped, in the editor; one made without fails
   * hours later with the note closed, and a row that quietly vanished from the panel
   * would be a photo lost without a word.
   */
  uploadNotices: ReadonlyMap<string, UploadNotice[]>;
}

export interface UploadNotice {
  /** The upload's file id: what a dismissal names. */
  id: string;
  filename: string;
  message: string;
}

export interface Outbox {
  executor: OfflineExecutor;
  /** The executor initialised and the entries it restored known; the library waits for this. */
  ready: Promise<void>;
  status: () => SyncStatus;
  subscribe: (listener: (status: SyncStatus) => void) => () => void;
  /**
   * Hears the server's copy after a replayed save of that note went through, with the
   * draft that save sent — what the person had then, so typing since can be told apart.
   */
  onAcknowledged: (listener: (noteId: string, note: Note, sent: NoteDraft) => void) => () => void;
  /** Forgets a conflict once a choice has been made. */
  resolveConflict: (noteId: string) => void;
  /** Forgets what was said about a note's uploads, once it has been read. */
  dismissUploadNotices: (noteId: string) => void;
  /**
   * Retires the save of this note still waiting in the queue, if there is one, ahead of a
   * new one: it is removed from storage, its change is taken off the row, and it will do
   * nothing when its turn comes. Answers with what the new save carries forward — the copy
   * the retired draft was made from, which is the older base, and the date it was to be
   * preconditioned on.
   */
  supersedeSave: (noteId: string) => { base: Note; against?: number | undefined } | null;
  /** The save of this note still waiting, as it stands: the draft, its base and where it came from. */
  waitingSave: (noteId: string) => { value: NoteDraft; base: Note; origin?: string | undefined } | null;
  /** Records the save of this note now waiting: its entry's id, what it carries, and how to take its change off the row. */
  trackSave: (noteId: string, entry: { id: string; value: NoteDraft; base: Note; against?: number | undefined; origin?: string | undefined; retire: () => void }) => void;
  /** Records an upload now waiting: its entry's id, what it carries, and how to take its row off. */
  trackUpload: (attachmentId: string, entry: { id: string; upload: { noteId: string; filename: string }; retire: () => void }) => void;
  /**
   * Takes back a file that has not uploaded yet: its entry leaves the queue, its row
   * comes off, its bytes leave the shelf. `sending` when the upload is on its way this
   * moment and cannot be recalled; `gone` when there is no such upload waiting.
   */
  cancelUpload: (attachmentId: string) => Promise<'cancelled' | 'sending' | 'gone'>;
  /** Records which notes an entry just queued is about, for `waiting`. */
  trackEntry: (id: string, noteIds: string[]) => void;
  /**
   * Writes the server's answer to a write made as a request into the local copy, as a
   * replayed entry's answer is written (`took`), waiting on a pull only when the answer
   * names something this device has no id for. For `restoreRevision`.
   */
  take: (note: Note) => Promise<void>;
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
 * This tab, as the origin of the saves it makes: minted once per page, so a save made
 * here as a client and one made here as the holder are the same editor's, and a save
 * restored from the outbox by the next holder is still the tab's that made it. What
 * tells two editors of one note apart in one outbox (`saveNote`).
 */
export const TAB_ORIGIN: string = crypto.randomUUID();

/**
 * A save: the whole draft, the copy it is diffed against for the patch, and, for "Keep
 * mine", the date to precondition on instead of the base's — the other device's copy,
 * so the patch is still only what was typed here and lands on top of theirs. `origin`
 * is the tab the save came from (`TAB_ORIGIN` there); a client sends its own with the
 * call.
 *
 * `definitions` is what the editor has already loaded (`rememberFieldDefs`). A request-
 * path save has no stored row for a first-time value, so the patch can encode it only
 * from a type; the queued path reads the library's set and does not need this. Empty is
 * "not yet", not "none".
 */
type Save = {
  noteId: string;
  value: NoteDraft;
  base: Note;
  against?: number;
  origin?: string;
  definitions?: FieldDef[];
};

/** The key a conflict is kept under in the outbox's storage; its entries are the `tx:` keys. */
const conflictKey = (noteId: string) => `conflict:${noteId}`;

/** An upload waiting in the queue: the note, the id and name its file will have, and what the row shows meanwhile. */
type Upload = { noteId: string; attachmentId: string; filename: string; contentType: string; size: number };

/** The key an upload's notice is kept under, beside the conflicts, for the same reason they are kept. */
const noticeKey = (attachmentId: string) => `upload-notice:${attachmentId}`;

/** What an outbox entry runs; the library does not export the name. */
type MutationFn = Parameters<typeof startOfflineExecutor>[0]['mutationFns'][string];

/**
 * What the outbox tells the library about: IndexedDB asking this tab's connection to
 * close, because another tab is deleting the database — a sign-out removes every
 * account's outbox (`store/wipe.ts`) — or opening it at a newer version, which a later
 * deploy's schema would. The connection is closed at once so the other tab's request
 * can go through, and the library it belongs to is told, since an outbox with no
 * connection is not one anything can queue on.
 */
export interface OutboxEvents {
  onAskedToClose?: () => void;
}

export function createOutbox(userId: string, lib: Omit<WritableLibrary, 'outbox'>, events: OutboxEvents = {}): Outbox {
  const conflicts = new Map<string, Conflict>();
  /** The notes each waiting entry is about, by entry id. */
  const entryNotes = new Map<string, string[]>();
  const waiting = (): ReadonlySet<string> => new Set([...entryNotes.values()].flat());
  /**
   * Whether an attempt ended the entry: it went through, or the server refused it for
   * good. A lost connection, a 5xx, a lapsed session, a timeout or a rate limit keeps
   * the entry (`refusal`), and its notes keep waiting.
   */
  const ended = (entryId: string, err?: unknown) => {
    if (err === undefined || err instanceof NonRetriableError) entryNotes.delete(entryId);
  };
  const keep = (noteId: string, conflict: Conflict) => {
    conflicts.set(noteId, conflict);
    void storage.set(conflictKey(noteId), JSON.stringify(conflict)).catch((err: unknown) => console.error('[outbox] conflict not kept:', err));
  };
  const notices = new Map<string, UploadNotice[]>();
  const notice = (upload: Upload, message: string) => {
    const said = { id: upload.attachmentId, filename: upload.filename, message };
    notices.set(upload.noteId, [...(notices.get(upload.noteId) ?? []).filter((n) => n.id !== said.id), said]);
    void storage.set(noticeKey(upload.attachmentId), JSON.stringify({ noteId: upload.noteId, ...said })).catch((err: unknown) => console.error('[outbox] upload notice not kept:', err));
  };
  const listeners = new Set<(s: SyncStatus) => void>();
  const acks = new Set<(id: string, note: Note, sent: NoteDraft) => void>();
  const status = (): SyncStatus => ({ pending: storage.held(), durable: executor.isOfflineEnabled, waiting: waiting(), conflicts, uploadNotices: notices });
  const touch = () => {
    const s = status();
    listeners.forEach((l) => l(s));
  };

  const defs = (): FieldDef[] => [...lookups(snapshot(lib)).fieldDefs.values()];

  /** The save of each note still waiting, by entry id, and the entries a later save retired. */
  const waitingSaves = new Map<string, { id: string; value: NoteDraft; base: Note; against?: number | undefined; origin?: string | undefined; retire: () => void }>();
  const superseded = new Set<string>();

  /**
   * The uploads still waiting, by the id their file will have; the entries taken back
   * before their turn; and the one being sent now, which is past taking back.
   */
  const waitingUploads = new Map<string, { id: string; upload: { noteId: string; filename: string }; retire: () => void }>();
  const cancelled = new Set<string>();
  let sending: string | null = null;

  /**
   * The server refused the request for good, or for now: which, is the queue's whole question.
   *
   * A 4xx is usually the same answer however often it is asked — a name the route will
   * not take, a file over the cap, a note that is gone — and ending the entry lets the
   * ones behind it move. Three are not that, and `refusedForGood` in `feed.ts` names
   * them for the walk and the queue alike: 401 replays after the sign-in that follows.
   */
  const refusal = (err: unknown): never => {
    if (isOfflineError(err)) throw err;
    if (err instanceof ApiError && refusedForGood(err.status)) {
      throw new NonRetriableError(err.message);
    }
    throw err;
  };

  /**
   * Every entry's attempt, with the keep-or-end decision left to this file alone.
   *
   * The library's own retry policy gives up on an error whose *message* contains "400",
   * "401", "403" or "422" — wherever in the text, and whatever the status. Our messages
   * start with the status (`httpErrorMessage`), so a queued save refused for a lapsed
   * session read "401 …" and was ended there, before `refusal` had any say, and a 503
   * whose page said "400 ms" was ended with it. The policy is fixed inside the executor
   * and cannot be configured, so anything kept goes to it under a message with nothing in
   * it to match, and the error it came from as its `cause`. `NonRetriableError` passes as
   * it is: that is the one way an entry ends.
   */
  const decided = (fns: Record<string, MutationFn>): Record<string, MutationFn> =>
    Object.fromEntries(
      Object.entries(fns).map(([name, fn]) => [
        name,
        async (params) => {
          try {
            return await fn(params);
          } catch (err) {
            if (err instanceof NonRetriableError) throw err;
            // The executor records the message and not the cause, so this is the one
            // place a queue stuck on a 429 or a lapsed session says so outside a debugger.
            console.debug('[outbox] kept:', err);
            throw new Error('Not sent yet; it will be tried again', { cause: err });
          }
        },
      ]),
    );

  const adapter = new IndexedDBAdapter(outboxName(userId));
  /** The adapter's connection: a private field, pinned by `pins.test.ts`; null until its first use. */
  const connection = () => (adapter as unknown as { db?: IDBDatabase | null }).db ?? null;
  const storage = watched(adapter, () => touch());
  const executor = startOfflineExecutor({
    // Both, so a reload restores an upload's row as it restores a save's text.
    collections: { notes: lib.notes, attachments: lib.attachments },
    storage,
    onlineDetector: connectivityDetector(),
    // Ours rather than the library's: per account, and a follower is promoted when the
    // holder goes, rather than left making every write a request for good (`leader.ts`).
    leaderElection: new OutboxLeader(outboxLeaderName(userId)),
    onLeadershipChange: () => touch(),
    mutationFns: decided({
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
          acks.forEach((l) => l(noteId, updated, value));
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
      /*
       * A file added with no connection: its bytes are on the `pending` shelf, and this
       * sends them through the route every upload goes through, so the quota, the text
       * extraction and the vision read are the server's as they always are.
       *
       * Under the id the row was made with: a request whose answer was lost is sent
       * again, and the server answers the second with the file the first one made.
       *
       * The bytes leave the shelf when the entry ends, either way. Gone through, they go
       * into the cache of opened files first — the photo just taken should still draw on
       * the next flight, and it is as good as opened. Refused for good, there is nothing
       * to keep them for, and the notice says what happened.
       *
       * A refused session, a timeout and a rate limit are not refusals of the upload (see
       * `refusal`): the entry stays, and on a 401 the library is closed and kept
       * (`offline-cache.ts`) so the sign-in that follows replays it. An upload exists
       * nowhere but here; ending it on any of them would delete the only copy.
       */
      uploadFile: async ({ transaction }) => {
        const upload = transaction.metadata as unknown as Upload;
        const { noteId, attachmentId, filename, contentType } = upload;
        try {
          // Taken back while it waited: out of storage already, and nothing to send.
          if (cancelled.has(transaction.id)) {
            ended(transaction.id);
            return;
          }
          sending = attachmentId;
          const bytes = await readFile(userId, 'pending', noteId, filename);
          if (!bytes) throw new NonRetriableError(`The file was no longer on this device`);
          const file = new File([bytes], filename, { type: contentType });
          const answer = await api.uploadFile(noteId, file, { id: attachmentId }).catch(refusal);
          if (answer.filename !== filename) {
            // Another device added a file of this name to this note meanwhile, and the
            // server suffixed ours. The link written into the note names the other one.
            notice(upload, `Stored as “${answer.filename}”, since the note already had a “${filename}”. Check the link in the note.`);
          }
          uploadListeners.forEach((l) => l(noteId, answer, file));
          await remember(noteId, answer.filename, file);
          await removeFile(userId, 'pending', noteId, filename).catch(() => {});
          await settled();
          ended(transaction.id);
        } catch (err) {
          if (err instanceof NonRetriableError) {
            notice(upload, `Couldn’t upload. ${err.message}`);
            await removeFile(userId, 'pending', noteId, filename).catch(() => {});
          }
          ended(transaction.id, err);
          throw err;
        } finally {
          sending = null;
          cancelled.delete(transaction.id);
          // Kept through an attempt that will be made again; it can still be taken back.
          if (!entryNotes.has(transaction.id)) waitingUploads.delete(attachmentId);
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
    }),
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
   * Not while the library is not whole (`isWhole`). A pull then is the whole snapshot
   * walk — minutes on a phone — and an entry that waited for it held the queue behind
   * it, kept "syncing" up and timed a sign-out's drain out (review of #232). That is a
   * walk cut short as much as one under way: a failed page leaves `failed` with no
   * cursor, and the next pull resumes the walk, so testing for `hydrating` alone let
   * those entries wait for it again. The walk ends by following the feed from the `seq`
   * it began at, which carries this write too; the pull is asked for so a walk already
   * over picks it up, and not waited for.
   */
  const settled = () => {
    if (isWhole(lib.engine.state)) return lib.engine.pull();
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
      /*
       * Closed the moment another tab asks for the database to be deleted or opened at
       * a newer version, which IndexedDB tells every connection through `versionchange`
       * and which the adapter does not listen for. A delete held open by this handler's
       * absence is what wedged every later sign-in on the device; the story is on
       * `CHANNEL` in `store/wipe.ts`. The library is told, and closes with the outbox.
       *
       * After `keys()`, not after `waitForInit`: the adapter opens its database on first
       * use, and on init only the tab that leads the outbox uses it (it restores the
       * entries); in every other tab — the ones a sign-out elsewhere is about — the
       * connection does not exist until the read above.
       */
      const db = connection();
      if (db) {
        db.onversionchange = () => {
          db.close();
          events.onAskedToClose?.();
        };
      }
      for (const t of entries) {
        entryNotes.set(t.id, notesOf(t.metadata as Record<string, unknown> | undefined));
        // The executor's private cleanup, for the reason given below; an upload a reload
        // restored can be taken back as one queued a moment ago can.
        const restored = (executor as unknown as { cleanupRestorationTransaction?: (id: string, rollback: boolean) => void }).cleanupRestorationTransaction;
        if (t.mutationFnName === 'uploadFile') {
          const u = t.metadata as Upload | undefined;
          if (u) waitingUploads.set(u.attachmentId, { id: t.id, upload: u, retire: () => restored?.call(executor, t.id, true) });
        }
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
        if (m && !waitingSaves.has(m.noteId)) waitingSaves.set(m.noteId, { id: t.id, value: m.value, base: m.base, against: m.against, origin: m.origin, retire: () => cleanup?.call(executor, t.id, true) });
      }
      for (const key of keys) {
        if (key.startsWith('upload-notice:')) {
          const raw = await storage.get(key);
          if (!raw) continue;
          const { noteId, ...said } = JSON.parse(raw) as UploadNotice & { noteId: string };
          notices.set(noteId, [...(notices.get(noteId) ?? []), said]);
          continue;
        }
        if (!key.startsWith('conflict:')) continue;
        const raw = await storage.get(key);
        if (raw) conflicts.set(key.slice('conflict:'.length), JSON.parse(raw) as Conflict);
      }
      if (conflicts.size > 0 || entryNotes.size > 0 || notices.size > 0) touch();
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
    dismissUploadNotices: (noteId) => {
      const said = notices.get(noteId);
      if (!said) return;
      notices.delete(noteId);
      for (const n of said) void storage.delete(noticeKey(n.id)).catch(() => {});
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
    waitingSave: (noteId) => {
      const waiting = waitingSaves.get(noteId);
      return waiting ? { value: waiting.value, base: waiting.base, origin: waiting.origin } : null;
    },
    trackSave: (noteId, entry) => {
      waitingSaves.set(noteId, entry);
    },
    take: async (note) => {
      if (!took(note)) await settled();
    },
    trackUpload: (attachmentId, entry) => {
      waitingUploads.set(attachmentId, entry);
    },
    cancelUpload: async (attachmentId) => {
      const waiting = waitingUploads.get(attachmentId);
      if (!waiting) return 'gone';
      if (sending === attachmentId) return 'sending';
      waitingUploads.delete(attachmentId);
      cancelled.add(waiting.id);
      // As a superseded save goes: out of storage now, so a reload does not bring it back,
      // and off the row now rather than when its turn would have come.
      await executor.removeFromOutbox(waiting.id).catch(() => {});
      waiting.retire();
      entryNotes.delete(waiting.id);
      await removeFile(userId, 'pending', waiting.upload.noteId, waiting.upload.filename).catch(() => {});
      touch();
      return 'cancelled';
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
      connection()?.close?.();
    },
  };
}

/**
 * Puts a file that just uploaded into the cache of opened files, under its address, so it
 * still draws with no connection once it has left the `pending` shelf. The worker is told,
 * and its ledger takes the file in (`sw/budget.ts`); it is evicted like any other.
 * Best-effort: without Cache Storage the file is simply fetched when next looked at.
 *
 * Not a file over the cache's own cap, which the worker would not have kept had it been
 * opened online: it is in the account now, and draws again with a connection, or with
 * its notebook kept.
 */
async function remember(noteId: string, filename: string, file: File): Promise<void> {
  if (typeof caches === 'undefined' || file.size > MAX_KEPT_FILE) return;
  try {
    const url = `/api/notes/${encodeURIComponent(noteId)}/files/${encodeURIComponent(filename)}`;
    const headers = { 'Content-Type': file.type || 'application/octet-stream', 'Content-Length': String(file.size) };
    await (await caches.open(FILES_CACHE)).put(url, new Response(file, { headers }));
    // Told now, so the index counts the file at once rather than at the worker's next
    // store: Settings said "nothing kept" with this file sitting in the cache.
    navigator.serviceWorker?.controller?.postMessage({ type: FILES_CHANGED });
  } catch {
    // No room, or no cache in this context.
  }
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

/**
 * A tab that does not hold the account's library is a client of the tab that does
 * (`client-library.ts`), and its writes are the holder's to queue: each action below
 * asks here first and, given a way across, sends its name and arguments rather than
 * running. The holder runs the same function — the one registered in `forwardable` —
 * where the client's `forward` is null and the write lands in its outbox, durable and in
 * order with the holder's own. Before 2026-10-13 such a tab made every write a request,
 * which offline was a save refused.
 */
export type Forward = ((name: keyof typeof forwardable, args: unknown[]) => Promise<unknown>) & {
  /** Whether the account the call was for is still the one this tab holds; absent means yes. */
  stillMine?: () => boolean;
};

let forward: () => Promise<Forward | null> = async () => null;

/** How the actions find the holder's door when this tab is a client; set by `store/library.ts`. */
export function provideForwarder(fn: () => Promise<Forward | null>): void {
  forward = fn;
}

/** The actions a client may ask the holder to run, by name: `forwardable`, at the end of this file. */
type Forwardable = typeof forwardable;

/** A call to the holder, typed by the registry, so a name or an argument list that does not match an action is a compile error here rather than `No such call` on the holder. */
type Away = <K extends keyof Forwardable>(name: K, args: Parameters<Forwardable[K]>, write?: LocalWrite) => Promise<Awaited<ReturnType<Forwardable[K]>>>;

/**
 * The way across to the holder, or null when this tab runs its writes itself. Told to
 * `onLocalWrite` before the call goes, as a queued write is told before its change
 * lands: the change comes back as the holder's rows, and the list has to have measured
 * itself before then. A call refused because the library moved — this tab became the
 * holder, or attached to a new one, with the call in hand — is simply made again, where
 * the library now is; unless it had reached a holder and is one that must not run twice
 * (`SEND_ONCE`), when the caller is told it may not have finished.
 */
/** Set while a call refused as moved is being run again here, so that run does not forward. */
let runningHere = 0;

async function away(): Promise<Away | null> {
  // Read before the first await: the re-run below sets this for the synchronous start
  // of the action it calls, which reaches here before anything else.
  const here = runningHere > 0;
  const fwd = here ? null : await forward();
  if (!fwd) return null;
  return async <K extends keyof Forwardable>(name: K, args: Parameters<Forwardable[K]>, write?: LocalWrite): Promise<Awaited<ReturnType<Forwardable[K]>>> => {
    type Out = Awaited<ReturnType<Forwardable[K]>>;
    if (write) aboutToWrite(write);
    try {
      return (await fwd(name, args)) as Out;
    } catch (err) {
      if (err instanceof LibraryMovedError) {
        if (err.sent && SEND_ONCE.has(name)) throw new CallUnsettledError(name);
        // Where the library now is may be another account's: a switch, with the call
        // in hand, replaces the client before its refusal is handled. The thing is not
        // done again as them.
        if (fwd.stillMine && !fwd.stillMine()) throw new Error('The account on this tab changed while this was in hand');
        // Run here, once: with a client still current that refuses again, forwarding
        // from the re-run would be this same catch without end.
        runningHere += 1;
        try {
          return (forwardable[name] as (...a: unknown[]) => Promise<Out>)(...args);
        } finally {
          runningHere -= 1;
        }
      }
      throw err;
    }
  };
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

const uploadListeners = new Set<(noteId: string, uploaded: api.UploadedFile, file: File) => void>();

/**
 * Hears each upload the queue got through, with the server's answer and the bytes. An
 * upload made as a request hands both to the indexer where it was made, so the file is
 * searchable from the bytes in hand; one made from the queue finishes with nobody
 * waiting on it, often after a reload, and this is where the indexer hears of it
 * (`main.tsx`). Module-wide rather than on an outbox: the listener outlives any library.
 */
export function onUploaded(listener: (noteId: string, uploaded: api.UploadedFile, file: File) => void): () => void {
  uploadListeners.add(listener);
  return () => void uploadListeners.delete(listener);
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

/** A write this device is about to make; see `onLocalWrite`. */
export interface LocalWrite {
  /**
   * The notes it touches. Empty when the server will name them, as it does a note made or
   * copied by request: nothing here knows its id until the answer.
   */
  ids: readonly string[];
  /**
   * Whether it can move a note between lists or change a count: a trash, a restore, a
   * purge, a move, a tag, a note made or copied, or a save that changes the notebook or the
   * tags. A save of the title, the body or a field cannot, and autosave makes those every
   * few seconds while someone types.
   */
  refiles: boolean;
}

const localListeners = new Set<(write: LocalWrite) => void>();
let lastRefile = -Infinity;

/**
 * Hears each write this device is about to make, queued or as a request, before it
 * reaches the rows: what the person did here, as opposed to what the feed brought from
 * another device or the first copy of the library. The interface answers its own changes
 * differently — a count that ticks over, a row that leaves the list rather than vanishing
 * — and this is how it tells them apart. Heard before the change lands, so a list can
 * still measure where its rows were: a queued write before its change reaches the rows, a
 * write made as a request once its answer is in (`pulled`). Told which notes the write
 * touches, so a list redrawn for some other reason in the moments after is not taken for
 * this write's doing.
 */
export function onLocalWrite(listener: (write: LocalWrite) => void): () => void {
  localListeners.add(listener);
  return () => void localListeners.delete(listener);
}

/**
 * Whether a write made here in the last `ms` could have moved a count: one that refiles a
 * note (`LocalWrite.refiles`). Long enough for the change to come back through the
 * collections and be drawn, short enough that the feed's next change is not mistaken for
 * it. Only refiling writes open the window, because autosave writes the text every few
 * seconds while someone types: counted, it held the window open for as long as they
 * typed, and every count the feed or the first copy moved meanwhile rolled as if they had.
 */
export function refiledLocallyWithin(ms: number): boolean {
  return performance.now() - lastRefile < ms;
}

function aboutToWrite(write: LocalWrite): void {
  if (write.refiles) lastRefile = performance.now();
  localListeners.forEach((l) => l(write));
}

/** The queued writes that can move a note between lists; a save says for itself. */
const REFILING = new Set([
  'createNote',
  'duplicateNote',
  'trashNote',
  'restoreNote',
  'purgeNote',
  'trashNotes',
  'restoreNotes',
  'purgeNotes',
  'moveNotes',
  'tagNotes',
]);

/**
 * After a write made as a request: whoever follows direct writes hears of it, and in a
 * tab that has a library but does not queue, the server's copy is brought to the local
 * copy now rather than on the next nudge, so the row on screen agrees with the answer.
 * Nothing to wait for; the library is already right about every row this did not touch.
 *
 * It is told to `onLocalWrite` once the answer is in, not when the request goes. Nothing
 * on the rows changed before it, so the list is still where it was, and the redraw is now
 * a pull away rather than a request and a pull: emptying a large trash outlasted the
 * list's wait for its redraw. A refused request is not a write at all, and is not told.
 */
async function pulled<T>(write: Promise<T>, local: LocalWrite): Promise<T> {
  const out = await write;
  aboutToWrite(local);
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
function queue(
  lib: WritableLibrary,
  mutationFnName: string,
  metadata: Record<string, unknown>,
  mutate: () => void,
  refiles = REFILING.has(mutationFnName),
): { id: string; retire: () => void } {
  if (!durable(lib)) throw new Error('queue() in a tab that does not hold the outbox'); // callers go through queueable()
  aboutToWrite({ ids: notesOf(metadata), refiles });
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

/*
 * A write to a note the local copy does not hold yet. `noteQuery` asks the server for
 * such a note while no snapshot has been taken — a link followed during the first walk,
 * which on a phone is minutes of pages — and the editor then saves it. TanStack DB's
 * `update` throws rather than inserting, so the save used to fail
 * (`UpdateKeyNotFoundError`) and the typing was gone on the next open. Search still hits
 * the server too, so a bulk action can name ids the walk has not reached; acting only on
 * the ones held here reported success and left the rest where they were.
 *
 * Those writes go as a request, the same way a device with no library sends them; the
 * walk's later apply of the same note, and the feed from the walk's starting seq, bring
 * the row. A bulk action is split: the notes held here are queued and only the rest are
 * the request. Sending the whole selection as a request was tried and undone — a note
 * held here may have an earlier write still waiting in the outbox, which then replayed
 * over the later choice, and the selection failed whole offline. The request goes before
 * the queue: its notes have no rows here, so nothing of theirs waits in the outbox to be
 * ordered behind, and a refusal then leaves nothing applied. Queued first, a failed
 * request left half the action done while the list said it failed, and skipped telling
 * the open note's draft, whose next save put the old filing back. `duplicateNote` already
 * asks the server for a source it does not hold.
 *
 * Once a snapshot has been taken, an id the copy does not hold is not a note, as in
 * `noteQuery`: a single write is refused as the route would refuse it, and a bulk action
 * leaves it out, since a selection outlives a purge the feed delivered.
 */

/**
 * Whether no snapshot has been taken yet: the line every read and write here draws. The
 * reads draw it in `notHeld` (`queries.ts`) from the library's `state()`, which is the
 * copy of this same engine state taken on its last change; a change to one must be a
 * change to both, or a note opens from the server and its save is refused as missing.
 */
const firstCopy = (lib: WritableLibrary) => lib.engine.state.cursor === null;

/** Whether a write to this note goes as a request because the first copy has not reached it. */
function notCopiedYet(lib: WritableLibrary, noteId: string): boolean {
  if (lib.notes.has(noteId)) return false;
  if (firstCopy(lib)) return true;
  throw new ApiError(404, 'Not found');
}

/** A bulk action's ids: the ones queued here, and the ones the first copy has not reached. */
function split(lib: WritableLibrary, ids: string[]): { here: string[]; there: string[] } {
  const here: string[] = [];
  const there: string[] = [];
  const copying = firstCopy(lib);
  for (const id of ids) {
    if (lib.notes.has(id)) here.push(id);
    else if (copying) there.push(id);
  }
  return { here, there };
}

/**
 * Field types a request-path save can encode a first-time value from.
 *
 * `buildNotePatch` skips a value that has no stored row and no definition, treating it
 * as a leftover id so a stale draft key cannot 400 the rest of the save. This path
 * used to pass `undefined` even when the tab held a library — it just did not hold the
 * outbox — so filling Amount for the first time in a second tab, or on a note opened
 * during the first copy, reported "Saved" and left the number nowhere. The queued path
 * already reads the library's definitions; this one does too, and takes any the editor
 * has already loaded for what the library does not hold.
 *
 * The library's copy wins by id: the feed keeps it current, while the editor's list
 * (`rememberFieldDefs`) keeps every definition it has seen, so a field converted in
 * another tab would otherwise be encoded with its old type and 400 the whole save. The
 * editor's list still fills in what the library lacks — everything, on a device with no
 * library, and a notebook the first copy has not reached yet.
 */
function definitionsFor(lib: WritableLibrary | null, handed?: FieldDef[]): FieldDef[] | undefined {
  const held = lib ? [...lookups(snapshot(lib)).fieldDefs.values()] : [];
  if (!handed?.length) return lib ? held : undefined;
  return [...new Map([...handed, ...held].map((d) => [d.id, d])).values()];
}

/**
 * The save as a request: no local row to change, or a tab that does not queue. `open` is
 * the library `saveNote` resolved, durable or not, so the types come from the library
 * that sent the save down this path rather than one resolved again across a switch.
 */
async function saveViaRequest(input: Save, open: WritableLibrary | null): Promise<'unchanged' | Note> {
  const patch = buildNotePatch(input.value, input.base, definitionsFor(open, input.definitions));
  if (!patch) return 'unchanged';
  const refiles = patch.notebook !== undefined || patch.tags !== undefined;
  return pulled(
    (async () => {
      try {
        return await api.updateNote(input.noteId, { ...patch, ifUpdatedAt: input.against ?? input.base.updatedAt });
      } catch (err) {
        if (!isNoteChanged(err) || input.against !== undefined || !holdsTheirChanges(input.value, input.base, err.current)) throw err;
        return api.updateNote(input.noteId, { ...patch, ifUpdatedAt: err.current.updatedAt });
      }
    })(),
    { ids: [input.noteId], refiles },
  );
}

/**
 * Saves a draft of a note against the copy the draft was made from. Resolves once the
 * change is on the local copy and in the outbox — "saved" on this device — with
 * `'unchanged'` when the draft differs from its base in nothing the server can hold.
 * The server's answer arrives later: through `onAcknowledged` when it took the save, in
 * `conflicts` when it refused one and the person has to choose.
 */
export async function saveNote(input: Save): Promise<'queued' | 'unchanged' | Note> {
  const far = await away();
  if (far) return far('saveNote', [{ ...input, origin: TAB_ORIGIN }], { ids: [input.noteId], refiles: input.value.notebook !== input.base.notebook || JSON.stringify(input.value.tags) !== JSON.stringify(input.base.tags) });
  // `queueable()` inlined: the request path wants the open library even when it does
  // not queue, for its field types.
  const open = await resolve();
  const lib = open && durable(open) ? open : null;
  if (!lib || notCopiedYet(lib, input.noteId)) {
    // No local copy on this device, a tab that does not queue, or a note the copy
    // does not hold yet: the save is the request, and its answer is the server's
    // copy — or the refusal, which the caller puts to the person.
    return saveViaRequest(input, open);
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
   *
   * That holds for one editor, whose every draft contains the one before. Two tabs of
   * one device now share this outbox (`client-library.ts`), and a tab's open editor
   * does not take up another tab's write while it waits here — the optimistic row keeps
   * its date, so the workspace reads it as nothing new — so its next autosave would
   * retire the other tab's save and patch against the oldest base, where the other
   * tab's change reads as unchanged: a rename made offline in one tab, gone on the
   * next keystroke in the other, with both saying "Saved" (review of #354). So a save
   * from another origin merges only when its draft already holds the waiting one's
   * changes, and is otherwise refused as the server would refuse it, with the row as it
   * stands, which the workspace puts to the person as a conflict. Keep mine, pressed on
   * that conflict, comes back with `against`: a choice made with theirs in view, so it
   * is not refused again, and the draft is put over theirs — what the person changed
   * stays theirs, what they never touched takes the other tab's — rather than retiring
   * the waiting save with whatever it changed that the draft never had.
   */
  const origin = input.origin ?? TAB_ORIGIN;
  const waiting = lib.outbox.waitingSave(input.noteId);
  // A waiting save with no origin was written before saves carried one; whose it was is
  // not known, and it merges as every save did then.
  if (waiting && waiting.origin !== undefined && waiting.origin !== origin) {
    const theirs = { ...waiting.base, title: waiting.value.title, body: waiting.value.body, tags: waiting.value.tags, notebook: waiting.value.notebook, fields: valuesOf(waiting.value, lib) };
    if (input.against !== undefined) input = { ...input, value: rebaseAfterAck(input.value, seedFrom(input.base), theirs) };
    else if (!holdsTheirChanges(input.value, input.base, theirs)) {
      const row = lib.notes.get(input.noteId);
      throw new NoteChangedError(row ? toNote(row, lookups(snapshot(lib))) : theirs);
    }
  }
  const carried = lib.outbox.supersedeSave(input.noteId);
  const base = carried && carried.base.updatedAt < input.base.updatedAt ? carried.base : input.base;
  const patch = buildNotePatch(input.value, base, [...lookups(snapshot(lib)).fieldDefs.values()]);
  if (!patch) return 'unchanged';
  const { value } = input;
  const entry: Save = { noteId: input.noteId, value, base, against: input.against ?? carried?.against, origin };
  const queued = queue(
    lib,
    'saveNote',
    entry as unknown as Record<string, unknown>,
    () => {
      lib.notes.update(input.noteId, (row) => {
        if (patch.title !== undefined) row.title = value.title;
        if (patch.body !== undefined) row.body = value.body;
        if (patch.tags !== undefined) row.tagNames = value.tags;
        if (patch.notebook !== undefined) row.notebookName = value.notebook;
        if (patch.fields !== undefined) row.fields = valuesOf(value, lib);
      });
    },
    patch.notebook !== undefined || patch.tags !== undefined,
  );
  lib.outbox.trackSave(input.noteId, { ...queued, value, base, against: entry.against, origin });
  return 'queued';
}

/**
 * Makes a note, with an id minted here, and answers with it at once. The id is minted
 * before the write is sent anywhere and travels with it, so a write that runs twice —
 * sent to the holder and run here after the library moved, or as a request after a
 * holder answered nothing — makes one note (`createOrFind` on the server).
 */
export async function createNote(input: { title: string; body: string; tags: string[]; notebook: string | null }, id: string = crypto.randomUUID()): Promise<Note> {
  const far = await away();
  if (far) return far('createNote', [input, id], { ids: [], refiles: true });
  const lib = await queueable();
  if (!lib) return pulled(api.createNote({ ...input, id }), { ids: [], refiles: true });
  const now = Date.now();
  const row: LocalNote = { id, title: input.title, body: input.body, createdAt: now, updatedAt: now, tagIds: [], tagNames: input.tags, notebookId: null, notebookName: input.notebook, files: [] };
  queue(lib, 'createNote', { id, ...input }, () => {
    lib.notes.insert(row);
  });
  return toNote(row, lookups(snapshot(lib)));
}

/** A copy of a note, under an id minted here before it is sent anywhere, as `createNote`'s is; the server copies its files. */
export async function duplicateNote(sourceId: string, copyId: string = crypto.randomUUID()): Promise<{ id: string }> {
  const far = await away();
  if (far) return far('duplicateNote', [sourceId, copyId], { ids: [], refiles: true });
  const lib = await queueable();
  if (!lib) return pulled(api.duplicateNote(sourceId, copyId), { ids: [], refiles: true });
  const source = lib.notes.get(sourceId);
  if (!source) return pulled(api.duplicateNote(sourceId, copyId), { ids: [], refiles: true });
  const now = Date.now();
  queue(lib, 'duplicateNote', { sourceId, copyId }, () => {
    lib.notes.insert({ ...source, id: copyId, createdAt: now, updatedAt: now, files: [] });
  });
  return { id: copyId };
}

/** How long `restoreRevision` and `clearHistory` wait for a note's own queued writes to reach the server. */
const RESTORE_DRAIN_MS = 5000;

/** Resolves true once the outbox has nothing waiting for this note, false if that takes too long. */
function drained(lib: WritableLibrary, noteId: string, timeout: number): Promise<boolean> {
  if (!lib.outbox.status().waiting.has(noteId)) return Promise.resolve(true);
  return new Promise((done) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      done(ok);
    };
    const timer = setTimeout(() => finish(false), timeout);
    // `subscribe` calls its listener at once, before it has returned the way out.
    let unsubscribe = () => {};
    unsubscribe = lib.outbox.subscribe((status) => {
      if (!status.waiting.has(noteId)) finish(true);
    });
  });
}

/**
 * Resolves once this note's queued writes have reached the server — true — or have
 * taken too long to — false. For a read of the server's history, which is only worth
 * making once the save that may have just added to it has landed.
 */
export async function synced(noteId: string, timeout = RESTORE_DRAIN_MS): Promise<boolean> {
  const far = await away();
  if (far) return far('synced', [noteId, timeout]);
  const lib = await resolve();
  return lib ? drained(lib, noteId, timeout) : true;
}

/**
 * Deletes a note's whole history on the server; how many versions went.
 *
 * It waits for the note's own queued writes, as a restore does, and for a sharper
 * reason. This is pressed to be rid of text — a password pasted in and taken out again
 * — and the save that took it out may still be in the outbox. Cleared first, the
 * history would be empty when that save landed, and the server would keep a copy of
 * what the save replaced: the very text, back in a history the person had just been
 * told was clear. So a queue that will not drain refuses the clear.
 */
export async function clearHistory(noteId: string): Promise<number> {
  const far = await away();
  if (far) return far('clearHistory', [noteId]);
  const lib = await resolve();
  if (lib && !(await drained(lib, noteId, RESTORE_DRAIN_MS))) {
    throw new Error('This note has changes that have not synced yet. Try again in a moment.');
  }
  return api.clearRevisions(noteId);
}

/**
 * Puts a copy from a note's history back as its title and body, and answers with the
 * note as the server then has it and the id of the copy the server kept of what it
 * replaced (`kept`; null when the version was already the note, and nothing was done).
 *
 * A request, not an entry in the outbox, and deliberately. History lives on the server
 * alone, so the sheet this is pressed in cannot open without a connection; and the
 * server keeps what the restore replaces in the same transaction, which is what makes a
 * restore undoable. Queued as a save of the old text it would be typing as far as the
 * server could tell, and typing inside the half-hour window keeps nothing.
 *
 * It waits for the note's own queued writes first. A save still in the outbox would
 * otherwise reach the server after the restore, find the note moved on, and come back
 * as a conflict between the person and themselves; and the text it carries would never
 * have been the server's, so the restore could not keep it. A queue that will not drain
 * — the server unreachable although the sheet opened — refuses the restore rather than
 * racing it.
 *
 * The answer is written into the local copy before this returns, the way a replayed
 * save's is, so the row agrees with the note handed back and the editor is not reseeded
 * from one while the list shows the other.
 *
 * `ifUpdatedAt` is the server's precondition, passed through for the Undo of a restore:
 * a `NoteChangedError` when the note has been saved since the date given.
 */
export async function restoreRevision(noteId: string, revisionId: number, opts: { ifUpdatedAt?: number } = {}): Promise<RestoredNote> {
  const far = await away();
  if (far) return far('restoreRevision', [noteId, revisionId, opts], { ids: [noteId], refiles: false });
  const lib = await resolve();
  if (lib && !(await drained(lib, noteId, RESTORE_DRAIN_MS))) {
    throw new Error('This note has changes that have not synced yet. Try again in a moment.');
  }
  const restored = await api.restoreRevision(noteId, revisionId, opts);
  // A version that was already the note changed nothing: no write to tell anyone about.
  if (restored.kept === null) return restored;
  directListeners.forEach((l) => l());
  if (lib) await lib.outbox.take(restored.note);
  return restored;
}

export async function trashNote(noteId: string): Promise<void> {
  const far = await away();
  if (far) return far('trashNote', [noteId], { ids: [noteId], refiles: true });
  const lib = await queueable();
  if (!lib || notCopiedYet(lib, noteId)) return pulled(api.deleteNote(noteId), { ids: [noteId], refiles: true });
  queue(lib, 'trashNote', { noteId }, () => {
    lib.notes.update(noteId, (row) => {
      row.deletedAt = Date.now();
    });
  });
}

export async function restoreNote(noteId: string): Promise<void> {
  const far = await away();
  if (far) return far('restoreNote', [noteId], { ids: [noteId], refiles: true });
  const lib = await queueable();
  if (!lib || notCopiedYet(lib, noteId)) return pulled(api.restoreNote(noteId).then(() => undefined), { ids: [noteId], refiles: true });
  queue(lib, 'restoreNote', { noteId }, () => {
    lib.notes.update(noteId, (row) => {
      delete row.deletedAt;
    });
  });
}

export async function purgeNote(noteId: string): Promise<void> {
  const far = await away();
  if (far) return far('purgeNote', [noteId], { ids: [noteId], refiles: true });
  const lib = await queueable();
  if (!lib || notCopiedYet(lib, noteId)) return pulled(api.deleteNotePermanently(noteId), { ids: [noteId], refiles: true });
  queue(lib, 'purgeNote', { noteId }, () => {
    lib.notes.delete(noteId);
  });
}

/**
 * Empties the trash: the server's own purge of every trashed note, sent as the request it
 * always was, since the server decides its extent — notes this device has not copied
 * included. Through here rather than straight to the API so it is a write like any other:
 * `ids` are the trashed notes on screen, which the list follows out, and the count rolls.
 */
export async function emptyTrash(ids: readonly string[]): Promise<api.PurgeResult> {
  const far = await away();
  if (far) {
    // A request on the holder too, so told to `onLocalWrite` once the answer is in, as
    // `pulled` tells it, and not at all for a refusal — not before the call goes, as a
    // queued write is told.
    const out = await far('emptyTrash', [ids]);
    aboutToWrite({ ids, refiles: true });
    return out;
  }
  return pulled(api.purgeNotes('trashed'), { ids, refiles: true });
}

/*
 * The bulk verbs answer with how many notes they acted on: the notes queued here, since
 * the server's count for those comes later from the queue, plus the server's count for
 * whatever went as a request. What the message after the action names.
 */

export async function trashNotes(ids: string[]): Promise<number> {
  const far = await away();
  if (far) return far('trashNotes', [ids], { ids, refiles: true });
  const lib = await queueable();
  if (!lib) return pulled(api.deleteNotes(ids).then((r) => r.trashed), { ids, refiles: true });
  const { here, there } = split(lib, ids);
  const remote = there.length > 0 ? await pulled(api.deleteNotes(there).then((r) => r.trashed), { ids: there, refiles: true }) : 0;
  if (here.length > 0) {
    queue(lib, 'trashNotes', { ids: here }, () => {
      const now = Date.now();
      for (const id of here) lib.notes.update(id, (row) => void (row.deletedAt = now));
    });
  }
  return here.length + remote;
}

export async function restoreNotes(ids: string[]): Promise<number> {
  const far = await away();
  if (far) return far('restoreNotes', [ids], { ids, refiles: true });
  const lib = await queueable();
  if (!lib) return pulled(api.restoreNotes(ids).then((r) => r.restored), { ids, refiles: true });
  const { here, there } = split(lib, ids);
  const remote = there.length > 0 ? await pulled(api.restoreNotes(there).then((r) => r.restored), { ids: there, refiles: true }) : 0;
  if (here.length > 0) {
    queue(lib, 'restoreNotes', { ids: here }, () => {
      for (const id of here) lib.notes.update(id, (row) => void delete row.deletedAt);
    });
  }
  return here.length + remote;
}

export async function purgeNotes(ids: string[]): Promise<number> {
  const far = await away();
  if (far) return far('purgeNotes', [ids], { ids, refiles: true });
  const lib = await queueable();
  if (!lib) return pulled(api.deleteNotesPermanently(ids).then((r) => r.deleted), { ids, refiles: true });
  const { here, there } = split(lib, ids);
  const remote = there.length > 0 ? await pulled(api.deleteNotesPermanently(there).then((r) => r.deleted), { ids: there, refiles: true }) : 0;
  if (here.length > 0) {
    queue(lib, 'purgeNotes', { ids: here }, () => {
      for (const id of here) lib.notes.delete(id);
    });
  }
  return here.length + remote;
}

export async function moveNotes(ids: string[], notebook: string | null): Promise<void> {
  const far = await away();
  if (far) return far('moveNotes', [ids, notebook], { ids, refiles: true });
  const lib = await queueable();
  if (!lib) return pulled(api.updateNotes(ids, { notebook }).then(() => undefined), { ids, refiles: true });
  const { here, there } = split(lib, ids);
  if (there.length > 0) await pulled(api.updateNotes(there, { notebook }), { ids: there, refiles: true });
  if (here.length > 0) {
    queue(lib, 'moveNotes', { ids: here, notebook }, () => {
      for (const id of here) lib.notes.update(id, (row) => void (row.notebookName = notebook));
    });
  }
}

export async function tagNotes(ids: string[], change: { add?: string[]; remove?: string[] }): Promise<void> {
  const far = await away();
  if (far) return far('tagNotes', [ids, change], { ids, refiles: true });
  const lib = await queueable();
  if (!lib) {
    return pulled(api.updateNotes(ids, { addTags: change.add, removeTags: change.remove }).then(() => undefined), {
      ids,
      refiles: true,
    });
  }
  const { here, there } = split(lib, ids);
  if (there.length > 0) {
    await pulled(api.updateNotes(there, { addTags: change.add, removeTags: change.remove }), { ids: there, refiles: true });
  }
  if (here.length > 0) {
    const l = lookups(snapshot(lib));
    const add = change.add ?? [];
    // `updateMany`'s rules, so the row reads now as it will once the server has it: names
    // compared without case (MAK-127), and a tag in both lists added.
    const adding = new Set(add.map(foldNoCase));
    const remove = new Set((change.remove ?? []).map(foldNoCase).filter((t) => !adding.has(t)));
    queue(lib, 'tagNotes', { ids: here, ...change }, () => {
      for (const id of here) {
        lib.notes.update(id, (row) => {
          const current = row.tagNames ?? row.tagIds.map((t) => l.tags.get(t)?.name).filter((n): n is string => !!n);
          const kept = current.filter((t) => !remove.has(foldNoCase(t)));
          const held = new Set(kept.map(foldNoCase));
          for (const t of add) {
            if (held.has(foldNoCase(t))) continue;
            held.add(foldNoCase(t));
            kept.push(t);
          }
          row.tagNames = kept;
        });
      }
    });
  }
}

/**
 * Adds a file to a note, and answers with where the note should link it.
 *
 * With a connection and nothing of the note's waiting, this is the request it always
 * was: the answer is the server's, a refusal — too big, over quota — is the caller's to
 * show where the file was dropped.
 *
 * Without one, or behind a write of the note's that has not gone through (a note made a
 * moment ago does not exist on the server yet), the file is kept and queued: its bytes
 * on the `pending` shelf, a row for it now, marked as waiting, and an entry in the outbox
 * after the note's own. The address in the answer works at once, because the service
 * worker serves the shelf.
 *
 * What the server would refuse later is refused here first, where someone can still do
 * something about it: a file over the upload cap, a name the route does not take, and a
 * file the device has no room to hold.
 */
export async function uploadFile(noteId: string, file: File, attachmentId: string = crypto.randomUUID()): Promise<api.UploadedFile> {
  /*
   * Before the first `await`, while the drop or the click that brought the file is still
   * what the browser sees this as part of: a browser that asks the person asks only then,
   * and by the time a file is known to be queued — the library looked up, the room
   * measured — that moment has passed (review of #236).
   *
   * Only when the app already knows it is offline, which is known without waiting and is
   * when a file is queued. Asked for every upload, a browser that prompts put "store data
   * on this device?" in front of someone attaching a file with a perfectly good
   * connection, about nothing they had done. The rarer ways into the queue — a note with
   * a write still waiting, a connection lost mid-upload — ask below, where the prompt may
   * not come; the next file added offline asks properly.
   */
  if (offlineNow()) askToPersist();
  // The holder's, as a call: the bytes cross with it, and the holder keeps or sends
  // them, under the id minted here, so a call that runs twice stores one file.
  const far = await away();
  if (far) return far('uploadFile', [noteId, file, attachmentId], { ids: [noteId], refiles: false });
  const lib = await queueable();
  /*
   * One id for the file, whichever way it goes. A request made directly can lose its
   * answer after the server has stored the file — a phone on one bar does this — and the
   * file is then queued: under the same id, the replay finds what the first request made;
   * under a new one it stored `scan-2.pdf` beside it and said so (review of #236). The
   * id is a parameter for the same reason one step out: a client's call that ran on the
   * holder and runs again here carries it.
   */
  const direct = () => pulled(api.uploadFile(noteId, file, { id: attachmentId }), { ids: [noteId], refiles: false });
  if (!lib || !filesSupported() || !lib.notes.has(noteId)) return direct();
  if (!offlineNow() && !lib.outbox.status().waiting.has(noteId)) {
    try {
      return await direct();
    } catch (err) {
      // The connection went while the bytes were on their way: keep the file after all.
      if (!isOfflineError(err)) throw err;
    }
  }

  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit`);
  const named = filenameSchema.safeParse(file.name);
  if (!named.success) throw new Error(named.error.issues[0]?.message ?? 'Invalid filename');
  const room = await navigator.storage.estimate?.().catch(() => null);
  if (room?.quota !== undefined && room.usage !== undefined && file.size > room.quota - room.usage) {
    throw new Error('Not enough room on this device to keep the file until it can upload');
  }

  const taken = [...lib.attachments.values()].filter((a) => a.noteId === noteId).map((a) => a.filename);
  const filename = availableFilename(taken, named.data);
  const contentType = file.type || 'application/octet-stream';
  // Again for the ways here that were not known at the start; a second ask is free.
  askToPersist();
  await writeFile(lib.userId, 'pending', noteId, filename, file);
  const upload: Upload = { noteId, attachmentId, filename, contentType, size: file.size };
  const queued = queue(lib, 'uploadFile', upload as unknown as Record<string, unknown>, () => {
    lib.attachments.insert({ id: attachmentId, noteId, filename, contentType, size: file.size, hasText: false, createdAt: Date.now(), pending: true });
  });
  lib.outbox.trackUpload(attachmentId, { ...queued, upload });
  // `server`: whoever reads this file's text does so when the upload goes through
  // (`onUploaded`), not now, when there is no server to give the text to.
  return { filename, contentType, size: file.size, path: `files/${filename}`, indexing: 'server' };
}

/**
 * Takes back a file added here that has not uploaded yet — the wrong photo, attached with
 * no connection. Purely local: its entry leaves the queue, its row comes off, its bytes
 * leave the device, and the server never hears of it. Without this the only way to be rid
 * of it was to wait for a connection, let it upload, and delete it then.
 *
 * False when the note has no such file waiting, and the caller's delete is the server's.
 * Throws when the file is being sent this very moment: that request cannot be recalled,
 * and in a moment the file is an ordinary one that can be deleted.
 */
export async function cancelUpload(noteId: string, filename: string): Promise<boolean> {
  const far = await away();
  if (far) return far('cancelUpload', [noteId, filename]);
  const lib = await resolve();
  if (!lib) return false;
  const row = [...lib.attachments.values()].find((a) => a.pending && a.noteId === noteId && a.filename === filename);
  if (!row) return false;
  const outcome = await lib.outbox.cancelUpload(row.id);
  if (outcome === 'sending') throw new Error(`“${filename}” is uploading right now. Delete it once it has.`);
  return outcome === 'cancelled';
}

/**
 * Deletes a file from a note, wherever it currently lives: a file still waiting to upload
 * is taken back on this device (the server has never heard of it, and a request for it
 * would fail with no connection), and anything else is the server's to delete.
 *
 * One function for the Attachments panel and the editor's inline bin, because they were
 * two copies of this rule once and the editor's had only the server half — so a picture
 * added offline could be deleted from the panel and not from the picture.
 */
export async function deleteOrCancelAttachment(noteId: string, filename: string): Promise<void> {
  if (!(await cancelUpload(noteId, filename))) await api.deleteAttachment(noteId, filename);
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
  const far = await away();
  if (far) return far('setNoteField', [noteId, def, value], { ids: [noteId], refiles: false });
  const lib = await queueable();
  const row = lib ? syncedRow(lib, noteId) : undefined;
  if (!lib || !row) return pulled(api.updateNote(noteId, { fields: { [def.id]: value } }), { ids: [noteId], refiles: false });
  const l = lookups(snapshot(lib));
  const base = toNote(row, l);
  const shown = toNote(lib.notes.get(noteId) ?? row, l);
  const value_ = { ...seedFrom(shown), fields: { ...seedFrom(shown).fields, [def.id]: value } };
  await saveNote({ noteId, value: value_, base });
  return toNote(lib.notes.get(noteId) ?? row, lookups(snapshot(lib)));
}

/**
 * Makes a notebook from a template, or adds a template's fields to one that exists, and
 * waits for the library to hold the result.
 *
 * A request, like every notebook and field change (see the module comment): its rules are
 * the server's, and it needs a connection. What it adds over `pulled` is the wait. The
 * chooser opens the notebook's table straight after, and a library that had not heard of
 * the notebook yet would draw that as "Notebook not found" until the socket's nudge
 * arrived. So the pull is awaited here — but only while the library is whole. Without a
 * whole copy (a first copy walking, or one cut short and about to resume), the pull is
 * the rest of the walk, minutes on a phone, and the notebook is already made; the walk
 * ends by following the feed past this write, and nothing reports a notebook missing
 * while the library is not whole. It is asked for then, not waited on.
 */
export async function applyNotebookTemplate(
  definition: NotebookDefinition,
  opts: { create: boolean },
): Promise<{ id: string; skipped: api.NotebookImportSkip[] } | 'taken'> {
  const far = await away();
  if (far) return far('applyNotebookTemplate', [definition, opts]);
  const out = await api.importNotebook(definition, opts);
  if (out === 'taken') return out;
  directListeners.forEach((l) => l());
  const lib = await resolve();
  if (lib && isWhole(lib.engine.state)) await lib.engine.pull();
  else if (lib) void lib.engine.pull();
  return out;
}

/*
 * What a client may ask the holder to run (`library-serve.ts`). Every write above, and
 * the two that wait on a note's queued writes before a request (`clearHistory`,
 * `restoreRevision`), since the queue they wait on is the holder's. Not
 * `deleteOrCancelAttachment`, which composes `cancelUpload` and a request and runs
 * where it is called; nor `onUploaded`'s listeners, which fire in the holder for an
 * upload its queue got through — a client's own upload answers the client that made it.
 *
 * A failure crosses back as its class only for the classes `carry` and `revive` in
 * `library-channel.ts` know; an action added here that throws a class its caller
 * branches on with `instanceof` must be added there too, or the caller sees a plain
 * `Error`.
 */
export const forwardable = {
  saveNote,
  createNote,
  duplicateNote,
  synced,
  clearHistory,
  restoreRevision,
  trashNote,
  restoreNote,
  purgeNote,
  emptyTrash,
  trashNotes,
  restoreNotes,
  purgeNotes,
  moveNotes,
  tagNotes,
  uploadFile,
  cancelUpload,
  setNoteField,
  applyNotebookTemplate,
};

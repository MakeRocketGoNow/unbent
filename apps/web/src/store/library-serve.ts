import { OfflineError } from '../notes-api.js';
import { forwardable, type Outbox } from './actions.js';
import type { Collection } from '@tanstack/db';
import type { Collections } from './collections.js';
import type { FeedState } from './feed.js';
import type { Keeper } from './keep.js';
import type { SearchIndex } from './search-index.js';
import type { SearchSync } from './search-sync.js';
import { carry, type ClientMessage, type Message, type Port, type RowChange } from './library-channel.js';
import { LIBRARY_ROOTS, rootsOfNoteChanges } from './library-roots.js';

/**
 * The holding tab's side of the account's channel (`library-channel.ts`): what makes the
 * library it holds the library of every other tab on the device.
 *
 * On a client's hello it sends the four collections as rows, chunked, then `attached`
 * with the feed's state and the outbox's and keeper's status; from then on it forwards
 * every change the collections report, with the query roots the batch reaches, and
 * every move of those three statuses. The rows are read and posted in one go, with no
 * await between the first and the last, so a change that fires meanwhile is posted
 * after the snapshot it is already in, and a change that fired before it is in the
 * snapshot and was posted to a client not yet attached, which drops it. Every apply on
 * the client is an upsert by id, so a change seen twice is harmless.
 *
 * A call is run by name: the actions, which land in this outbox; the index, whose FTS
 * tables are in this tab's file; the keeper; and the few things the outbox is asked.
 * Only what is listed runs, and the failure goes back as its class (`carry`).
 */

/** How many rows one `rows` message carries; a message per chunk keeps each clone short. */
export const ROWS_PER_MESSAGE = 1000;
/**
 * A hello from a client that was answered this recently is not answered again. A client
 * says hello every `HELLO_RETRY_MS` until rows arrive, and two of its hellos can be in
 * the holder's queue before the first answer has left; the whole library twice is the
 * one thing a phone must not be sent.
 */
export const HELLO_DEDUPE_MS = 1000;

export interface Serving {
  collections: Collections;
  state: () => FeedState;
  onState: (listener: (state: FeedState) => void) => () => void;
  outbox: Outbox;
  keeper: Keeper;
  search: () => { index: SearchIndex; sync: SearchSync } | null;
  searchReady: Promise<void>;
}

export interface Server {
  /** The index moved; the clients' local searches ask again. */
  indexed: () => void;
  /** The collections have been emptied for a walk from nothing. */
  reset: () => void;
  /** Says the library is closing and stops; the clients wait for the next holder. */
  stop: () => void;
}

const INDEX_CALLS = new Set(['candidates', 'snippets', 'meta', 'held']);
const KEEPER_CALLS = new Set(['keep', 'release', 'releaseAll']);
const OUTBOX_CALLS = new Set(['resolveConflict', 'dismissUploadNotices', 'cancelUpload']);

export function serveLibrary(port: Port, lib: Serving): Server {
  const holder = crypto.randomUUID();
  const { collections } = lib;
  const entities = { note: collections.notes, notebook: collections.notebooks, tag: collections.tags, attachment: collections.attachments } as const;
  let stopped = false;

  const run = async (name: string, args: unknown[]): Promise<unknown> => {
    const [scope, method] = name.split('.', 2);
    if (scope === 'index' && method && INDEX_CALLS.has(method)) {
      await lib.searchReady;
      const search = lib.search();
      if (!search) throw new OfflineError();
      return (search.index[method as 'candidates'] as (...a: unknown[]) => unknown)(...args);
    }
    if (name === 'search.opened') {
      await lib.searchReady;
      return lib.search()?.sync.opened(args[0] as string);
    }
    if (scope === 'keeper' && method && KEEPER_CALLS.has(method)) return (lib.keeper[method as 'keep'] as (...a: unknown[]) => unknown)(...args);
    if (scope === 'outbox' && method && OUTBOX_CALLS.has(method)) return (lib.outbox[method as 'cancelUpload'] as (...a: unknown[]) => unknown)(...args);
    const action = forwardable[name];
    if (!action) throw new Error(`No such call: ${name}`);
    return action(...(args as never[]));
  };

  /** When each client was last sent the rows. */
  const answered = new Map<string, number>();
  const hello = async (client: string) => {
    const now = Date.now();
    if (now - (answered.get(client) ?? -Infinity) < HELLO_DEDUPE_MS) return;
    answered.set(client, now);
    await Promise.all([collections.notes.preload(), collections.notebooks.preload(), collections.tags.preload(), collections.attachments.preload()]);
    if (stopped) return;
    for (const [entity, collection] of Object.entries(entities)) {
      const rows = [...collection.values()] as object[];
      for (let at = 0; at < rows.length; at += ROWS_PER_MESSAGE) {
        port.post({ type: 'rows', holder, client, entity: entity as keyof typeof entities, rows: rows.slice(at, at + ROWS_PER_MESSAGE) });
      }
      // A collection with no rows still names itself, so the client holds an empty map for it.
      if (rows.length === 0) port.post({ type: 'rows', holder, client, entity: entity as keyof typeof entities, rows: [] });
    }
    port.post({ type: 'attached', holder, client, state: lib.state(), status: lib.outbox.status(), keep: lib.keeper.status() });
  };

  const onMessage = (message: Message) => {
    if (stopped) return;
    const m = message as ClientMessage;
    if (m.type === 'hello') return void hello(m.client);
    if (m.type === 'ping') return port.post({ type: 'pong', holder, client: m.client });
    if (m.type === 'call') {
      // Answered even after `stop`: a call that was running when this holder began to
      // close has still run, and its client would otherwise send it to the next holder
      // as if it had not. The port outlives `stop` until the library's close; a post
      // after that is the one thing here that can throw, and the answer is then lost
      // as a crashed tab's would be (`client-library.ts` says what that costs).
      const answer = (message: Message) => {
        try {
          port.post(message);
        } catch {
          // The channel is closed.
        }
      };
      void run(m.name, m.args).then(
        (value) => answer({ type: 'answer', holder, client: m.client, id: m.id, ok: true, value }),
        (err: unknown) => answer({ type: 'answer', holder, client: m.client, id: m.id, ok: false, error: carry(err) }),
      );
    }
  };

  /** Forwards one collection's changes as they are reported, less what the client does not read. */
  const forwarding = <T extends object>(entity: keyof typeof entities, collection: Collection<T, string>) => {
    const subscription = collection.subscribeChanges((changes) => {
      const roots = entity === 'note' ? rootsOfNoteChanges(changes) : LIBRARY_ROOTS;
      port.post({
        type: 'changes',
        holder,
        entity,
        changes: changes.map((c): RowChange => (c.type === 'delete' ? { type: 'delete', key: String(c.key) } : { type: c.type, value: c.value })),
        roots: [...roots],
      });
    });
    return () => subscription.unsubscribe();
  };

  const subscriptions = [
    port.listen(onMessage),
    forwarding('note', collections.notes),
    forwarding('notebook', collections.notebooks),
    forwarding('tag', collections.tags),
    forwarding('attachment', collections.attachments),
    lib.onState((state) => port.post({ type: 'state', holder, state })),
    lib.outbox.subscribe((status) => port.post({ type: 'status', holder, status })),
    lib.outbox.onAcknowledged((noteId, note, sent) => port.post({ type: 'acknowledged', holder, noteId, note, sent })),
    lib.keeper.subscribe((status) => port.post({ type: 'keep', holder, status })),
  ];

  port.post({ type: 'serving', holder });

  return {
    indexed: () => port.post({ type: 'indexed', holder }),
    reset: () => port.post({ type: 'reset', holder }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const stop of subscriptions) stop();
      port.post({ type: 'closing', holder });
    },
  };
}

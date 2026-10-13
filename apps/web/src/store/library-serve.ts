import { OfflineError } from '../notes-api.js';
import { forwardable, type Outbox } from './actions.js';
import type { Collection } from '@tanstack/db';
import type { Collections } from './collections.js';
import type { FeedState } from './feed.js';
import type { Keeper } from './keep.js';
import type { SearchIndex } from './search-index.js';
import type { SearchSync } from './search-sync.js';
import { carry, HOLDER_CALLS, type ClientMessage, type HolderCall, type Message, type Port, type RowChange } from './library-channel.js';
import { LIBRARY_ROOTS, rootsOfNoteChanges } from './library-roots.js';

/**
 * The holding tab's side of the account's channel (`library-channel.ts`): what makes the
 * library it holds the library of every other tab on the device.
 *
 * On a client's hello it sends the four collections as rows, chunked, then `attached`
 * with the feed's state and the outbox's and keeper's status; from then on it forwards
 * every change the collections report, with the query roots the batch reaches, and
 * every move of those three statuses. The rows are read in one go — a snapshot of the
 * collections as they stand — and posted a chunk at a time with a task between, so the
 * holder's own tab is not held for the whole clone of an archive. A change that fires
 * between two chunks is posted between them, before the snapshot that already holds it
 * has all arrived; the client keeps every change a holder posts from its first rows on
 * and applies them after the rows (`early` in `client-library.ts`), and every apply is
 * an upsert by id, so a change applied over a snapshot that holds it is harmless.
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

const holderCalls: ReadonlySet<string> = new Set(HOLDER_CALLS);

/** `holder` is this holder's id, which the port was opened with so this tab alone hears the calls and pings addressed to it. */
export function serveLibrary(port: Port, lib: Serving, holder: string): Server {
  const { collections } = lib;
  const entities = { note: collections.notes, notebook: collections.notebooks, tag: collections.tags, attachment: collections.attachments } as const;
  let stopped = false;

  const run = async (name: string, args: unknown[]): Promise<unknown> => {
    if (holderCalls.has(name)) {
      const [scope, method] = (name as HolderCall).split('.') as [string, string];
      if (scope === 'index') {
        await lib.searchReady;
        const search = lib.search();
        if (!search) throw new OfflineError();
        return (search.index[method as 'candidates'] as (...a: unknown[]) => unknown)(...args);
      }
      if (scope === 'search') {
        await lib.searchReady;
        return lib.search()?.sync.opened(args[0] as string);
      }
      if (scope === 'keeper') return (lib.keeper[method as 'keep'] as (...a: unknown[]) => unknown)(...args);
      return (lib.outbox[method as 'cancelUpload'] as (...a: unknown[]) => unknown)(...args);
    }
    if (!Object.hasOwn(forwardable, name)) throw new Error(`No such call: ${name}`);
    const action = forwardable[name as keyof typeof forwardable] as (...a: unknown[]) => Promise<unknown>;
    return action(...args);
  };

  /**
   * The clients attached, by their hellos and byes. With none, nothing is forwarded:
   * `postMessage` clones in the sender whether or not anyone listens, and one tab is
   * the usual case, so a holder alone would otherwise clone every feed page of a first
   * copy and every autosave for nobody. A client whose page went without a bye is
   * counted until the holder closes, which costs what every holder cost before.
   */
  const clients = new Set<string>();
  const anyone = () => clients.size > 0;
  /** When each client was last sent the rows. */
  const answered = new Map<string, number>();
  /**
   * Each client's latest send, numbered. A send is a chunk a task, so a hello that
   * arrives while one is on its way — a client that asked again before the first chunk
   * reached it — starts a second, and the two would otherwise interleave; the earlier
   * one stops, and its number tells the client which chunks to keep.
   */
  const sends = new Map<string, number>();
  const hello = async (client: string) => {
    clients.add(client);
    const now = Date.now();
    if (now - (answered.get(client) ?? -Infinity) < HELLO_DEDUPE_MS) return;
    answered.set(client, now);
    const send = (sends.get(client) ?? 0) + 1;
    sends.set(client, send);
    const superseded = () => stopped || sends.get(client) !== send;
    await Promise.all([collections.notes.preload(), collections.notebooks.preload(), collections.tags.preload(), collections.attachments.preload()]);
    if (superseded()) return;
    // The snapshot now, as references; the clone happens in each post, one chunk a task.
    const snapshot = Object.entries(entities).map(([entity, collection]) => [entity as keyof typeof entities, [...collection.values()] as object[]] as const);
    for (const [entity, rows] of snapshot) {
      // A collection with no rows still names itself, so the client holds an empty map for it.
      for (let at = 0; at < Math.max(rows.length, 1); at += ROWS_PER_MESSAGE) {
        if (superseded()) return;
        port.post({ type: 'rows', holder, client, send, entity, rows: rows.slice(at, at + ROWS_PER_MESSAGE) });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (superseded()) return;
    port.post({ type: 'attached', holder, client, send, state: lib.state(), status: lib.outbox.status(), keep: lib.keeper.status() });
  };

  const onMessage = (message: Message) => {
    if (stopped) return;
    const m = message as ClientMessage;
    if (m.type === 'hello') return void hello(m.client);
    if (m.type === 'bye') {
      clients.delete(m.client);
      answered.delete(m.client);
      // Not forgotten but moved on: a send running at the bye stops at its next chunk,
      // and a later hello from the same id — a page back from the back/forward cache —
      // numbers past it rather than from one again, which could meet the old send.
      sends.set(m.client, (sends.get(m.client) ?? 0) + 1);
      port.forget(m.client);
      return;
    }
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

  /**
   * The changes of the task in hand, by collection, posted as one message once the task
   * ends — as the holder's own queries are told once per task (`changed` in
   * `library.ts`). A message per collection had a client re-deriving its views once per
   * collection a feed page touched.
   */
  let batches: Array<{ entity: keyof typeof entities; changes: RowChange[] }> = [];
  let roots = new Set<string>();
  let flushing = false;
  const flush = () => {
    flushing = false;
    const sent = batches;
    const reached = roots;
    batches = [];
    roots = new Set();
    if (sent.length === 0 || stopped) return;
    port.post({ type: 'changes', holder, batches: sent, roots: [...reached] });
  };
  /**
   * Forwards one collection's changes as they are reported, less what the client does
   * not read. Subscribed with the collection's state included, which it emits once as
   * inserts, to nobody, since no client is attached before the library is built: a
   * subscription without it reports only the rows it has emitted before, and the
   * removal of a row that never changed since the holder began serving — a note purged
   * on another device, say — was never reported, and stayed in every client's mirror.
   */
  const forwarding = <T extends object>(entity: keyof typeof entities, collection: Collection<T, string>) => {
    const subscription = collection.subscribeChanges((changes) => {
      if (!anyone()) return;
      for (const r of entity === 'note' ? rootsOfNoteChanges(changes) : LIBRARY_ROOTS) roots.add(r);
      batches.push({ entity, changes: changes.map((c): RowChange => (c.type === 'delete' ? { type: 'delete', key: String(c.key) } : { type: c.type, value: c.value })) });
      if (flushing) return;
      flushing = true;
      queueMicrotask(flush);
    }, { includeInitialState: true });
    return () => subscription.unsubscribe();
  };

  const subscriptions = [
    port.listen(onMessage),
    forwarding('note', collections.notes),
    forwarding('notebook', collections.notebooks),
    forwarding('tag', collections.tags),
    forwarding('attachment', collections.attachments),
    lib.onState((state) => anyone() && port.post({ type: 'state', holder, state })),
    lib.outbox.subscribe((status) => anyone() && port.post({ type: 'status', holder, status })),
    lib.outbox.onAcknowledged((noteId, note, sent) => anyone() && port.post({ type: 'acknowledged', holder, noteId, note, sent })),
    lib.keeper.subscribe((status) => anyone() && port.post({ type: 'keep', holder, status })),
  ];

  port.post({ type: 'serving', holder });

  return {
    indexed: () => anyone() && port.post({ type: 'indexed', holder }),
    reset: () => anyone() && port.post({ type: 'reset', holder }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const stop of subscriptions) stop();
      port.post({ type: 'closing', holder });
    },
  };
}

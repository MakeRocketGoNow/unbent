import type { FeedEntity, Note } from '@unbent/shared';
import type { NoteDraft } from '../note-patch.js';
import { ApiError, NoteChangedError, OfflineError } from '../notes-api.js';
import type { FeedState } from './feed.js';
import type { SyncStatus } from './actions.js';
import type { KeepStatus } from './keep.js';
import { libraryChannelName } from './names.js';

/**
 * The channel between the one tab that holds an account's library and the account's
 * other tabs on the device, which are its clients (`client-library.ts`).
 *
 * One tab holds the library (`library-lock.ts`); until 2026-10-13 every other tab read
 * the server and made each write a request, which online was slower than the copy and
 * offline was nothing. The shape most local-first apps land on is one owner and many
 * clients: one process holds the database, every tab talks to it. On the desktop the
 * owner could be a SharedWorker; Android Chrome has none, so the owner is the holding
 * tab, elected by the lock that already exists — and this protocol does not care which,
 * so a worker can take the holder's seat later with no change on the client's side.
 *
 * The client does not ask the holder its queries. It is sent the holder's four
 * collections as rows, once, when it attaches, and every change to them after, and it
 * derives what it draws from those rows itself, as the holder does (`derive.ts` works
 * from any snapshot). The holder is then a mirror's source and a queue's door, and
 * answers nothing per keystroke in another tab. What does cross as a call is what only
 * the holder can do: a write, which lands in its outbox and replays in order with its
 * own; a search of its index, since the FTS tables are in its file; keeping a notebook;
 * and the few things the outbox is asked by name. A call's answer and its failure come
 * back under the call's id, with the failure's class carried across (`carry`, `revive`),
 * since the workspace tells a refused precondition from a lost connection by class.
 *
 * BroadcastChannels, not a MessagePort: a port cannot be sent over a BroadcastChannel,
 * and the only other way to one is a worker, which is the thing Android has not got.
 * One channel is the account's, which every tab of the account listens on: hellos,
 * byes, the holder's announcements, and the changes and statuses every client wants.
 * What is for one tab alone goes on a channel named for that tab, which it alone
 * listens on: a client's rows, which are the whole library, its `attached`, its answers
 * and its pongs; and the holder's calls and pings, since a call carries a draft and
 * only the holder runs it. A browser decodes a message in every tab that listens
 * before any of them can drop it, so the library sent on the shared channel would have
 * been decoded by every tab of the account, tens of megabytes each, whenever any one of
 * them reloaded.
 *
 * Why not TanStack DB's own cross-tab paths, or wa-sqlite's cooperative access handle,
 * which are still underneath: they are what wedged before one tab held the library
 * (forty commits in four days, see `library-lock.ts`), and nothing exercises them now.
 * This is one channel with one owner, and its every message is listed here.
 */

/** A change to one row of a collection, as the holder's collection reported it, less what the client does not need. */
export type RowChange = { type: 'insert' | 'update'; value: object } | { type: 'delete'; key: string };

/** A failure carried across the channel: what `revive` needs to make the same class again. */
export interface Carried {
  name: string;
  message: string;
  status?: number;
  current?: Note;
}

/**
 * What a client may ask of the holder besides the actions in `forwardable`
 * (`actions.ts`): the four reads a search makes of the index, a note opened for the
 * index to want its files' text, keeping a notebook, and the three things a component
 * asks the outbox. One list, typed, so a name that is not here is a compile error on
 * the client rather than `No such call` on the holder.
 */
export const HOLDER_CALLS = [
  'index.candidates',
  'index.snippets',
  'index.meta',
  'index.held',
  'search.opened',
  'keeper.keep',
  'keeper.release',
  'keeper.releaseAll',
  'outbox.resolveConflict',
  'outbox.dismissUploadNotices',
  'outbox.cancelUpload',
] as const;
export type HolderCall = (typeof HOLDER_CALLS)[number];

export type ClientMessage =
  /** A tab that wants the rows: the holder answers with `rows` then `attached`, to it alone. */
  | { type: 'hello'; client: string }
  /** For one holder, on its own channel (`to`): a call carries a draft, and only the holder reads it. */
  | { type: 'call'; client: string; to: string; id: number; name: string; args: unknown[] }
  /** Is the holder still there? Answered with `pong`; see `HOLDER_SILENT_MS`. */
  | { type: 'ping'; client: string; to: string }
  /** A client closing, or its page going: the holder stops counting it. */
  | { type: 'bye'; client: string };

export type HolderMessage =
  /**
   * A tab has been granted the lock and is opening the library: a client waiting for a
   * holder keeps waiting rather than taking the library over from a tab that answers
   * nothing (`UNANSWERED_HELLOS` in `client-library.ts`). Sent before the open, so a
   * hand-off on a phone, where the open takes seconds, is not read as silence.
   */
  | { type: 'opening'; holder: string }
  /** A holder has started serving: every client says hello again, to it. */
  | { type: 'serving'; holder: string }
  /** `send` numbers the holder's sends to this client: a hello answered while one is on its way starts another, and the client keeps only the latest. */
  | { type: 'rows'; holder: string; client: string; send: number; entity: FeedEntity; rows: object[] }
  /** The rows are all sent; what else the client mirrors, as it stands now. */
  | { type: 'attached'; holder: string; client: string; send: number; state: FeedState; status: SyncStatus; keep: KeepStatus }
  /** The changes of one task of the holder's, by collection, and the query roots they reach (`rootsOfNoteChanges`). */
  | { type: 'changes'; holder: string; batches: Array<{ entity: FeedEntity; changes: RowChange[] }>; roots: string[] }
  | { type: 'state'; holder: string; state: FeedState }
  | { type: 'status'; holder: string; status: SyncStatus }
  | { type: 'keep'; holder: string; status: KeepStatus }
  | { type: 'acknowledged'; holder: string; noteId: string; note: Note; sent: NoteDraft }
  | { type: 'indexed'; holder: string }
  /** The holder's collections have been emptied for a walk from nothing; the rows come again as inserts. */
  | { type: 'reset'; holder: string }
  | { type: 'pong'; holder: string; client: string }
  | { type: 'answer'; holder: string; client: string; id: number; ok: true; value: unknown }
  | { type: 'answer'; holder: string; client: string; id: number; ok: false; error: Carried }
  /** The holder is closing its library; its clients wait for the next one. */
  | { type: 'closing'; holder: string };

export type Message = ClientMessage | HolderMessage;

/** One end of the account's channels, as both sides use it. */
export interface Port {
  /** Posts to the account's channel, or, for a message that is one client's alone, to that client's. */
  post: (message: Message) => void;
  /** Hears every message other tabs post for this tab; never this tab's own. */
  listen: (handler: (message: Message) => void) => () => void;
  /** Closes the channel to a client that has said bye; a holder opens one per client it answers, and a reload is a new client. */
  forget: (clientId: string) => void;
  close: () => void;
}

/** The messages that go to one client's channel rather than the account's; a message with `to` goes to that holder's. */
export const PRIVATE: ReadonlySet<Message['type']> = new Set<Message['type']>(['rows', 'attached', 'answer', 'pong']);

/** The channel one tab alone listens on, named for its client id or, for a holder, its holder id. */
export const clientChannelName = (userId: string, clientId: string) => `${libraryChannelName(userId)}-${clientId}`;

/** Which tab a message is for, or null for every tab of the account. */
export function addressee(message: Message): string | null {
  if ('to' in message) return message.to;
  if (PRIVATE.has(message.type) && 'client' in message) return message.client;
  return null;
}

/**
 * The account's channels in this tab — and, given this tab's client id, the one for it
 * alone — or null in a browser without BroadcastChannel, where there is nothing to
 * join. A holder opens a client's channel the first time it posts to that client and
 * keeps it until it closes.
 */
export function openPort(userId: string, clientId?: string): Port | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const handlers = new Set<(message: Message) => void>();
  const hear = (event: MessageEvent<Message>) => {
    const message = event.data;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    handlers.forEach((h) => h(message));
  };
  const shared = new BroadcastChannel(libraryChannelName(userId));
  shared.onmessage = hear;
  const own = clientId ? new BroadcastChannel(clientChannelName(userId, clientId)) : null;
  if (own) own.onmessage = hear;
  const clients = new Map<string, BroadcastChannel>();
  const to = (id: string) => {
    let channel = clients.get(id);
    if (!channel) {
      channel = new BroadcastChannel(clientChannelName(userId, id));
      clients.set(id, channel);
    }
    return channel;
  };
  return {
    post: (message) => {
      const target = addressee(message);
      if (target) to(target).postMessage(message);
      else shared.postMessage(message);
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    forget: (id) => {
      clients.get(id)?.close();
      clients.delete(id);
    },
    close: () => {
      handlers.clear();
      shared.close();
      own?.close();
      for (const c of clients.values()) c.close();
      clients.clear();
    },
  };
}

/**
 * A failure as it crosses the channel. An `Error` is cloneable but arrives as a plain
 * `Error` with the subclass gone, and the callers branch on the subclass: `isNoteChanged`
 * puts a conflict to the person, `isOfflineError` keeps an entry rather than ending it.
 * So what is sent is the name, the message and the two fields those classes carry.
 * These two and `ApiError` are the classes that cross; a forwarded action that throws
 * another class its caller branches on must be added here and in `revive`, or the
 * caller sees a plain `Error` with the name and nothing else.
 */
export function carry(err: unknown): Carried {
  if (err instanceof NoteChangedError) return { name: err.name, message: err.message, status: err.status, current: err.current };
  if (err instanceof ApiError) return { name: err.name, message: err.message, status: err.status };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Error', message: String(err) };
}

/** The failure `carry` sent, as the class it was. */
export function revive(carried: Carried): Error {
  if (carried.name === 'NoteChangedError' && carried.current) return new NoteChangedError(carried.current);
  if (carried.name === 'OfflineError') return new OfflineError();
  if (carried.status !== undefined) return new ApiError(carried.status, carried.message);
  const err = new Error(carried.message);
  err.name = carried.name;
  return err;
}

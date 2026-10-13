import type { FeedNotebook, FeedTag, Note } from '@unbent/shared';
import type { NoteDraft } from '../note-patch.js';
import type { FeedState } from './feed.js';
import type { LocalAttachment, LocalNote } from './collections.js';
import type { Outbox, SyncStatus } from './actions.js';
import type { KeepStatus, Keeper } from './keep.js';
import type { SearchIndex } from './search-index.js';
import { revive, type HolderMessage, type Message, type Port } from './library-channel.js';

/**
 * An account's library as a tab that does not hold it sees it: the holder's rows,
 * mirrored, and the holder's door for everything else. See `library-channel.ts` for why
 * a mirror rather than a query a message away.
 *
 * The rows are four maps, filled from the holder's `rows` on attach and kept by its
 * `changes` after; `version` moves with each, so the queries' per-version cache
 * (`view` in `queries.ts`) works here as it does over the holder's collections. The
 * feed's state, the outbox's status and the keeper's are mirrored the same way, so the
 * banner, the status line, the Saved glyph and Settings → Offline read in this tab
 * what they read in the holder's. What is not a mirror is a call: a write, a search of
 * the index, keeping a notebook, a conflict resolved.
 *
 * Between holders — the one serving this tab closed, or its tab went — the rows stay
 * as they were and the calls wait, and this tab says hello until a holder answers. The
 * lock's queue decides who that is (`library-lock.ts`): often this very tab, in which
 * case this client is closed by the open that replaces it, and a call still in hand is
 * refused with `LibraryMovedError`, which its caller answers by doing the thing again
 * where the library now is (`away` in `actions.ts`). A call the old holder ran but never
 * answered — its tab went between the two, or was taken over with an upload still on its
 * way — is sent to the next holder again, or run here. So a call must be safe to run
 * twice: the writes that make something new mint its id where the person acted and
 * carry it (`createNote`, `duplicateNote`, `uploadFile`), and the server answers a
 * second request under an id it has with the thing the first one made.
 */

/** A client was closed with a call still in hand; the caller does the thing again where the library now is. */
export class LibraryMovedError extends Error {
  constructor() {
    super('The library moved to another tab while this was in hand');
    this.name = 'LibraryMovedError';
  }
}

/** How often a client without a holder says hello; a holder announces itself too, so this only covers one that was serving before the client opened. */
export const HELLO_RETRY_MS = 2000;
/**
 * How long after the first of a holder's rows the client waits for `attached` before
 * asking again. The asking stops the moment rows arrive — an archive is tens of
 * megabytes, which a phone takes longer than `HELLO_RETRY_MS` to receive, and every
 * hello sent meanwhile was answered with the whole library again — and only a send cut
 * short, by a holder that closed mid-way, starts it again.
 */
export const ATTACH_STALL_MS = 15_000;
/** How often an attached client asks its holder whether it is still there. */
export const PING_MS = 5_000;
/**
 * How long a holder may say nothing before its client stops waiting on it. A holder tab
 * the browser has frozen — a background tab on a phone, routinely — still holds the lock
 * and answers nothing, and a client's save would otherwise wait on it for good, with
 * the typing held nowhere but that tab. Three pings unanswered is a holder that is not
 * coming back on its own; the client takes the library over (`onSilent`), which closes
 * this client and sends its calls in hand to wherever the library is next
 * (`LibraryMovedError`). A holder busy on its main thread answers a ping between its
 * tasks; only one that runs nothing at all for this long reads as silent.
 */
export const HOLDER_SILENT_MS = 15_000;

/** What the queries read of a collection; the holder's TanStack collections answer it, and so do the client's maps. */
export interface Rows<T> {
  values: () => IterableIterator<T>;
  get: (id: string) => T | undefined;
  has: (id: string) => boolean;
  preload: () => Promise<void>;
  readonly size: number;
}

/** The outbox as a component sees it: `useOutbox` in `use-outbox.ts`. The holder's outbox has the rest. */
export type OutboxView = Pick<Outbox, 'status' | 'subscribe' | 'onAcknowledged' | 'resolveConflict' | 'dismissUploadNotices' | 'cancelUpload'>;

/** What a search asks of the index (`searchLocal`): the holder's index answers it, and so does the client's proxy to it. */
export type SearchReader = Pick<SearchIndex, 'candidates' | 'snippets' | 'meta' | 'held'>;

export interface ClientLibrary {
  readonly remote: true;
  userId: string;
  notes: Rows<LocalNote>;
  notebooks: Rows<FeedNotebook>;
  tags: Rows<FeedTag>;
  attachments: Rows<LocalAttachment>;
  version: () => number;
  state: () => FeedState;
  subscribe: (listener: (state: FeedState) => void) => () => void;
  outbox: OutboxView;
  keeper: Keeper;
  search: { index: SearchReader; sync: { opened: (noteId: string) => Promise<void> } };
  searchReady: Promise<void>;
  /** Whether a holder is serving this tab now. */
  attached: () => boolean;
  call: (name: string, args: unknown[]) => Promise<unknown>;
  close: () => Promise<void>;
}

export interface ClientHooks {
  /** A batch of changes arrived, reaching these query roots. */
  onChange: (roots: ReadonlySet<string>) => void;
  /** The holder has answered nothing for `HOLDER_SILENT_MS`; the client has detached and asks to take the library over. */
  onSilent: () => void;
  /** The rows were replaced whole: a holder attached, or attached again. */
  onAttached: () => void;
  onReset: () => void;
  onIndexed: () => void;
}

class Mirror<T extends object> implements Rows<T> {
  rows = new Map<string, T>();
  values = () => this.rows.values();
  get = (id: string) => this.rows.get(id);
  has = (id: string) => this.rows.has(id);
  preload = async () => {};
  get size() {
    return this.rows.size;
  }
}

type Maps = { note: Mirror<LocalNote>; notebook: Mirror<FeedNotebook>; tag: Mirror<FeedTag>; attachment: Mirror<LocalAttachment> };
const freshMaps = (): Maps => ({ note: new Mirror(), notebook: new Mirror(), tag: new Mirror(), attachment: new Mirror() });

const starting: FeedState = { phase: 'starting', cursor: null, lastError: null, total: null, applied: 0, pulls: 0, resets: 0 };
const nothingWaiting: SyncStatus = { pending: 0, durable: false, waiting: new Set(), conflicts: new Map(), uploadNotices: new Map() };
const keepingNothing: KeepStatus = { supported: false, kept: new Set(), counted: false, wanted: { files: 0, bytes: 0 }, have: { files: 0, bytes: 0 }, fetching: false, problem: null };

/** A call in hand: what it asks, and which holder it has been sent to, so a holder that attaches this client twice is not asked twice. */
type Pending = { name: string; args: unknown[]; sentTo: string | null; resolve: (value: unknown) => void; reject: (err: unknown) => void };

/**
 * Joins the account's channel as a client — `me` is this client's id, which the port was
 * opened with so this tab alone hears what is for it — and answers once a holder has
 * sent its rows. Rejects only when `halting` aborts first — a close or a switch took this open's entry
 * — with an `AbortError`; a holder that never answers is waited for, since the caller's
 * wait is bounded elsewhere (`acquireLibrary`) and the step it is in must end on the
 * queue's terms.
 */
export function attachClientLibrary(userId: string, me: string, port: Port, hooks: ClientHooks, halting: AbortSignal): Promise<ClientLibrary> {
  let holder: string | null = null;
  let incoming: { holder: string; maps: Maps } | null = null;
  let maps = freshMaps();
  let version = 0;
  let feed = starting;
  let status = nothingWaiting;
  let keep = keepingNothing;
  const feedListeners = new Set<(s: FeedState) => void>();
  const statusListeners = new Set<(s: SyncStatus) => void>();
  const keepListeners = new Set<(s: KeepStatus) => void>();
  const acks = new Set<(noteId: string, note: Note, sent: NoteDraft) => void>();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;

  let hello: ReturnType<typeof setInterval> | null = null;
  let stall: ReturnType<typeof setTimeout> | null = null;
  const sayHello = () => port.post({ type: 'hello', client: me });
  const stopAsking = () => {
    if (hello) clearInterval(hello);
    hello = null;
    if (stall) clearTimeout(stall);
    stall = null;
  };
  /** Says hello now and keeps saying it, once per `HELLO_RETRY_MS`, until a holder's rows arrive. */
  const askNow = () => {
    if (closed) return;
    stopAsking();
    sayHello();
    hello = setInterval(sayHello, HELLO_RETRY_MS);
  };

  /** When the holder this client is attached to was last heard from. */
  let lastHeard = 0;
  let pinger: ReturnType<typeof setInterval> | null = null;
  const stopPinging = () => {
    if (pinger) clearInterval(pinger);
    pinger = null;
  };
  const startPinging = () => {
    stopPinging();
    pinger = setInterval(() => {
      if (!holder) return;
      if (Date.now() - lastHeard > HOLDER_SILENT_MS) {
        console.warn('[library] the tab holding this account’s library has stopped answering; taking it over');
        detach();
        hooks.onSilent();
        return;
      }
      port.post({ type: 'ping', client: me });
    }, PING_MS);
  };

  const send = (id: number, p: Pending) => {
    p.sentTo = holder;
    port.post({ type: 'call', client: me, id, name: p.name, args: p.args });
  };

  const detach = () => {
    holder = null;
    incoming = null;
    stopPinging();
    askNow();
  };

  let attachedOnce = false;
  let resolveAttach!: (lib: ClientLibrary) => void;
  let rejectAttach!: (err: unknown) => void;
  const attach = new Promise<ClientLibrary>((resolve, reject) => {
    resolveAttach = resolve;
    rejectAttach = reject;
  });

  const onMessage = (message: Message) => {
    if (closed) return;
    const m = message as HolderMessage;
    if ('holder' in m && m.holder === holder) lastHeard = Date.now();
    switch (m.type) {
      case 'serving':
        // A holder other than the one this tab is attached to: the one before it has
        // gone, whether or not its `closing` arrived. One hello, from `detach`.
        if (m.holder !== holder) detach();
        return;
      case 'rows':
        if (m.client !== me) return;
        if (!incoming || incoming.holder !== m.holder) incoming = { holder: m.holder, maps: freshMaps() };
        for (const row of m.rows) incoming.maps[m.entity].rows.set((row as { id: string }).id, row as never);
        // The rows are on their way: no more hellos, unless `attached` never follows.
        stopAsking();
        stall = setTimeout(askNow, ATTACH_STALL_MS);
        return;
      case 'attached': {
        if (m.client !== me) return;
        // Rows that never came, or came from another holder: ask again.
        if (!incoming || incoming.holder !== m.holder) return sayHello();
        maps = incoming.maps;
        holder = m.holder;
        incoming = null;
        lastHeard = Date.now();
        startPinging();
        version += 1;
        feed = m.state;
        status = m.status;
        keep = m.keep;
        stopAsking();
        feedListeners.forEach((l) => l(feed));
        statusListeners.forEach((l) => l(status));
        keepListeners.forEach((l) => l(keep));
        // The calls in hand go to this holder — unless it has them already: a holder
        // answers every hello, and a second hello reached it before this client heard
        // the first answer.
        for (const [id, p] of pending) if (p.sentTo !== m.holder) send(id, p);
        if (!attachedOnce) {
          attachedOnce = true;
          resolveAttach(lib);
        }
        hooks.onAttached();
        return;
      }
      case 'changes':
        if (m.holder !== holder) return;
        for (const c of m.changes) {
          if (c.type === 'delete') maps[m.entity].rows.delete(c.key);
          else maps[m.entity].rows.set((c.value as { id: string }).id, c.value as never);
        }
        version += 1;
        hooks.onChange(new Set(m.roots));
        return;
      case 'state':
        if (m.holder !== holder) return;
        feed = m.state;
        feedListeners.forEach((l) => l(feed));
        return;
      case 'status':
        if (m.holder !== holder) return;
        status = m.status;
        statusListeners.forEach((l) => l(status));
        return;
      case 'keep':
        if (m.holder !== holder) return;
        keep = m.status;
        keepListeners.forEach((l) => l(keep));
        return;
      case 'acknowledged':
        if (m.holder !== holder) return;
        acks.forEach((l) => l(m.noteId, m.note, m.sent));
        return;
      case 'indexed':
        if (m.holder !== holder) return;
        hooks.onIndexed();
        return;
      case 'reset':
        if (m.holder !== holder) return;
        maps = freshMaps();
        version += 1;
        hooks.onReset();
        return;
      case 'answer': {
        if (m.client !== me) return;
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(revive(m.error));
        return;
      }
      case 'closing':
        if (m.holder === holder) detach();
        return;
      case 'pong':
        return;
      default:
        return;
    }
  };
  const stopListening = port.listen(onMessage);

  const call = (name: string, args: unknown[]): Promise<unknown> => {
    if (closed) return Promise.reject(new LibraryMovedError());
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const p: Pending = { name, args, sentTo: null, resolve, reject };
      pending.set(id, p);
      // Sent now when a holder is serving; else when the next one attaches.
      if (holder) send(id, p);
    });
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    stopAsking();
    stopPinging();
    stopListening();
    halting.removeEventListener('abort', onHalt);
    port.close();
    for (const p of pending.values()) p.reject(new LibraryMovedError());
    pending.clear();
    if (!attachedOnce) rejectAttach(new DOMException('The open was halted before a holder answered', 'AbortError'));
  };

  const onHalt = () => void close();
  if (halting.aborted) onHalt();
  else halting.addEventListener('abort', onHalt, { once: true });

  const proxyIndex: SearchReader = {
    candidates: (...args) => call('index.candidates', args) as never,
    snippets: (...args) => call('index.snippets', args) as never,
    meta: (...args) => call('index.meta', args) as never,
    held: (...args) => call('index.held', args) as never,
  };

  const lib: ClientLibrary = {
    remote: true,
    userId,
    get notes() {
      return maps.note;
    },
    get notebooks() {
      return maps.notebook;
    },
    get tags() {
      return maps.tag;
    },
    get attachments() {
      return maps.attachment;
    },
    version: () => version,
    state: () => feed,
    subscribe: (listener) => {
      feedListeners.add(listener);
      listener(feed);
      return () => void feedListeners.delete(listener);
    },
    outbox: {
      status: () => status,
      subscribe: (listener) => {
        statusListeners.add(listener);
        listener(status);
        return () => void statusListeners.delete(listener);
      },
      onAcknowledged: (listener) => {
        acks.add(listener);
        return () => void acks.delete(listener);
      },
      resolveConflict: (noteId) => void call('outbox.resolveConflict', [noteId]).catch(() => {}),
      dismissUploadNotices: (noteId) => void call('outbox.dismissUploadNotices', [noteId]).catch(() => {}),
      cancelUpload: (attachmentId) => call('outbox.cancelUpload', [attachmentId]) as never,
    },
    keeper: {
      status: () => keep,
      subscribe: (listener) => {
        keepListeners.add(listener);
        listener(keep);
        return () => void keepListeners.delete(listener);
      },
      keep: (notebookId) => call('keeper.keep', [notebookId]) as Promise<void>,
      release: (notebookId) => call('keeper.release', [notebookId]) as Promise<void>,
      releaseAll: () => call('keeper.releaseAll', []) as Promise<void>,
      // The holder's passes are nudged by its own library; nothing here to do.
      nudge: () => {},
      stop: () => {},
    },
    search: { index: proxyIndex, sync: { opened: (noteId) => call('search.opened', [noteId]) as Promise<void> } },
    searchReady: Promise.resolve(),
    attached: () => holder !== null,
    call,
    close,
  };

  if (!closed) askNow();
  return attach;
}

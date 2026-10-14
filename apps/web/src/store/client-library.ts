import type { FeedNotebook, FeedTag, Note } from '@unbent/shared';
import type { NoteDraft } from '../note-patch.js';
import type { FeedState } from './feed.js';
import type { LocalAttachment, LocalNote } from './collections.js';
import type { forwardable, Outbox, SyncStatus } from './actions.js';
import type { KeepStatus, Keeper } from './keep.js';
import type { SearchReader } from './search-index.js';
import type { ReadableLibrary } from './library.js';
import { revive, type HolderCall, type HolderMessage, type Message, type Port, type RowChange } from './library-channel.js';
/** Everything a client may ask the holder by name: an action, or one of the holder's own (`HOLDER_CALLS`). */
export type CallName = keyof typeof forwardable | HolderCall;

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

/**
 * A client was closed with a call still in hand; the caller does the thing again where
 * the library now is — unless the call had reached a holder and is one that must not run
 * twice (`SEND_ONCE`), in which case the caller is told it may not have finished.
 */
export class LibraryMovedError extends Error {
  constructor(readonly sent: boolean) {
    super('The library moved to another tab while this was in hand');
    this.name = 'LibraryMovedError';
  }
}

/** A call that reached a holder whose answer never came, and that must not be sent again; what the caller shows. */
export class CallUnsettledError extends Error {
  constructor(name: string) {
    super(`${name} may not have finished: the tab it was sent to went before answering. Check, then try again.`);
    this.name = 'CallUnsettledError';
  }
}

/**
 * The calls that are not safe to run twice, and so are never sent to a second holder or
 * run here after reaching one: emptying the trash purges whatever is in it when it runs,
 * a notebook made from a template answers "taken" to its own second run, and a restore
 * with a precondition is refused by the one that went through. Everything else either
 * carries an id the server answers again with the thing the first run made, or is a
 * save, a filing or a read that comes out the same twice.
 */
export const SEND_ONCE: ReadonlySet<string> = new Set(['emptyTrash', 'applyNotebookTemplate', 'restoreRevision']);

/**
 * How long a client without a holder waits before saying hello again, doubling each time
 * to `HELLO_RETRY_MAX_MS`. A holder announces itself, so this only covers one that was
 * serving before the client opened; a holder whose open is wedged would otherwise be
 * asked every two seconds for as long as the tab is open.
 */
export const HELLO_RETRY_MS = 2000;
export const HELLO_RETRY_MAX_MS = 30_000;
/**
 * How many hellos a client that has never been served sends with nothing heard from any
 * holder, and over at least how long, before it takes the library over. A live holder
 * answers a hello from its message handler, which the browser runs even in a hidden
 * tab, and a tab still opening answers it with `opening`, so three hellos with no
 * `serving`, no rows and no `opening` is a tab that holds the lock and runs nothing for
 * this account: one frozen by the browser, or one on a build from before the channel
 * existed, which cannot answer a hello at all. Until this, such a tab cost every reload
 * the whole of `LIBRARY_OPEN_TIMEOUT_MS` — twenty seconds of nothing, then the server —
 * which is what a deploy looked like with an older tab left open (2026-10-14).
 *
 * The two numbers are not the same bound. The count is what decides, and where the
 * third hello lands depends on the backoff: six seconds from a cold start (now, two
 * seconds on, four more), and later after an `opening` started the count over, since
 * the backoff goes on doubling. The clock is a floor under the count, not a bound of
 * its own: a tab resumed from a freeze fires its overdue hello timers in a burst, and
 * three sent in a moment would otherwise read a live holder as silent before its
 * queued answer was processed. Don't change one to match the other.
 *
 * Only before the first attach. A client that was served once has its rows, and from
 * then on a holder gone quiet is judged by pings with a call in hand (`SILENT_PINGS`),
 * since a steal from an idle client undid a person's Open here elsewhere. A tab that
 * was granted the lock says `opening` before its open and again to every hello until it
 * serves, each of which starts the count over: the open on a phone takes seconds, and a
 * hand-off is exactly when a client is waiting on one.
 */
export const UNANSWERED_HELLOS = 3;
export const HELLO_UNANSWERED_MS = 5_000;
/**
 * How long after the first of a holder's rows the client waits for `attached` before
 * asking again. The asking stops the moment rows arrive — an archive is tens of
 * megabytes, which a phone takes longer than `HELLO_RETRY_MS` to receive, and every
 * hello sent meanwhile was answered with the whole library again — and only a send cut
 * short, by a holder that closed mid-way, starts it again.
 */
export const ATTACH_STALL_MS = 15_000;
/** How often a client with a call in hand asks its holder whether it is still there; an idle client asks nothing, since a holder gone costs it nothing until it has something to send. */
export const PING_MS = 5_000;
/**
 * How long, and how many pings, a holder may leave unanswered before its client stops
 * waiting on it. A holder tab the browser has frozen — a background tab on a phone,
 * routinely — still holds the lock and answers nothing, and a client's save would
 * otherwise wait on it for good, with the typing held nowhere but that tab. Silence is
 * pings unanswered, never time since the holder last spoke: a hidden tab's interval
 * runs once a minute under Chrome's throttling, and a tab resumed from a freeze fires
 * its overdue timer before the pong queued for it, so a clock alone read a live, idle
 * holder as gone and took the library from the tab the person was using (review of #354).
 * `SILENT_PINGS` unanswered over at least this long is a holder that is not coming
 * back on its own; the client takes the library over (`onSilent`), which closes this
 * client and sends its calls in hand to wherever the library is next
 * (`LibraryMovedError`). A holder busy on its main thread answers a ping between its
 * tasks; only one that runs nothing at all reads as silent.
 *
 * The cost of the takeover, decided and accepted: this client's rows go with it, and
 * the open that follows waits on the frozen tab's file for up to the open's bound
 * before the tab reads the server, so a working mirror becomes nothing for that long.
 * The save is what a frozen holder loses for good, and the rows are only stale; keeping
 * the maps serving reads under an open in progress would be a second library behind
 * `current`, and was not worth that.
 */
export const HOLDER_SILENT_MS = 15_000;
export const SILENT_PINGS = 3;
/**
 * How long a client that was attached waits for the next holder with no one serving. A
 * holder that said `closing` is usually followed within seconds by the next tab in the
 * lock's queue opening the library; but that tab may be one the browser has frozen,
 * granted the lock and never to open, or the old holder's close may have wedged before
 * letting go. A save in hand would wait for good either way, so after this long with
 * no sign of a holder — a `serving`, a chunk of rows — and a call waiting, the client
 * asks to take the library over as it does from a silent holder. As long as the open's
 * own bound (`LIBRARY_OPEN_TIMEOUT_MS`), since a hand-over is an open on a phone.
 */
export const ORPHANED_MS = 20_000;

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
  search: NonNullable<ReadableLibrary['search']>;
  searchReady: Promise<void>;
  /** Whether a holder is serving this tab now. */
  attached: () => boolean;
  call: (name: CallName, args: unknown[]) => Promise<unknown>;
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
  /** The rows arriving from a holder's numbered send, and the changes it posted while they did, applied after them. */
  let incoming: { holder: string; send: number; maps: Maps; early: Array<Array<{ entity: keyof Maps; changes: RowChange[] }>> } | null = null;
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

  let hello: ReturnType<typeof setTimeout> | null = null;
  let stall: ReturnType<typeof setTimeout> | null = null;
  let attachedOnce = false;
  /** Hellos sent since any holder last said anything, and when the first of them went: see `UNANSWERED_HELLOS`. */
  let silentHellos = 0;
  let firstSilentHello = 0;
  let askedToTakeOver = false;
  /** A holder spoke — any holder, anything — so the tab is not one that runs nothing. */
  const heard = () => {
    silentHellos = 0;
  };
  const sayHello = () => {
    port.post({ type: 'hello', client: me });
    if (attachedOnce || askedToTakeOver) return;
    if (silentHellos === 0) firstSilentHello = Date.now();
    silentHellos += 1;
    if (silentHellos >= UNANSWERED_HELLOS && Date.now() - firstSilentHello >= HELLO_UNANSWERED_MS) {
      askedToTakeOver = true;
      console.warn('[library] the tab holding this account’s library answers nothing; taking it over');
      hooks.onSilent();
    }
  };
  const stopAsking = () => {
    if (hello) clearTimeout(hello);
    hello = null;
    if (stall) clearTimeout(stall);
    stall = null;
  };
  /** Says hello now and keeps saying it, each wait twice the last, until a holder's rows arrive. */
  const askNow = () => {
    if (closed) return;
    stopAsking();
    sayHello();
    let wait = HELLO_RETRY_MS;
    const again = () => {
      sayHello();
      wait = Math.min(wait * 2, HELLO_RETRY_MAX_MS);
      hello = setTimeout(again, wait);
    };
    hello = setTimeout(again, wait);
  };

  /** Pings sent since the holder last said anything, and when the first of them went. */
  let unanswered = 0;
  let firstUnanswered = 0;
  let pinger: ReturnType<typeof setInterval> | null = null;
  const stopPinging = () => {
    if (pinger) clearInterval(pinger);
    pinger = null;
  };
  /** Pings while a call is in hand, and not otherwise: see `PING_MS`. */
  const startPinging = () => {
    if (pinger) return;
    unanswered = 0;
    pinger = setInterval(() => {
      if (!holder) return;
      if (unanswered >= SILENT_PINGS && Date.now() - firstUnanswered > HOLDER_SILENT_MS && pending.size > 0) {
        console.warn('[library] the tab holding this account’s library has stopped answering; taking it over');
        detach(false);
        hooks.onSilent();
        return;
      }
      if (unanswered === 0) firstUnanswered = Date.now();
      unanswered += 1;
      port.post({ type: 'ping', client: me, to: holder });
    }, PING_MS);
  };
  /** Between holders: the bound on waiting for the next one (`ORPHANED_MS`). */
  let orphaned: ReturnType<typeof setTimeout> | null = null;
  const stopOrphanWatch = () => {
    if (orphaned) clearTimeout(orphaned);
    orphaned = null;
  };
  /**
   * Starts, or starts again, the wait for a holder: counted from the last sign of one —
   * `closing`, a `serving`, each chunk of rows — never from `closing` alone, since the
   * next holder's open on a phone and the library's arrival after it can together
   * outlast the bound, and a client that fired then took the library from the very tab
   * the person had pressed Open here in (review of #354). Only ever fires with a call waiting:
   * an idle client has nothing a frozen or missing holder can lose it, and a steal
   * from one undid a person's Open here elsewhere in favour of a background tab.
   */
  const watchForHolder = () => {
    stopOrphanWatch();
    if (!attachedOnce || closed) return;
    orphaned = setTimeout(() => {
      orphaned = null;
      if (holder || closed || pending.size === 0) return;
      console.warn('[library] no tab has served this account’s library since the last one closed; taking it over');
      hooks.onSilent();
    }, ORPHANED_MS);
  };

  const send = (id: number, p: Pending) => {
    if (!holder) return;
    p.sentTo = holder;
    port.post({ type: 'call', client: me, to: holder, id, name: p.name, args: p.args });
  };

  /** Puts one message's changes into the maps, collection by collection. */
  const apply = (batches: Array<{ entity: keyof Maps; changes: RowChange[] }>) => {
    for (const b of batches) {
      for (const c of b.changes) {
        if (c.type === 'delete') maps[b.entity].rows.delete(c.key);
        else maps[b.entity].rows.set((c.value as { id: string }).id, c.value as never);
      }
    }
  };

  /** Lets go of the holder; with `watch`, bounds the wait for the next one (a takeover already asked for needs no bound). */
  const detach = (watch = true) => {
    holder = null;
    incoming = null;
    stopPinging();
    askNow();
    if (watch) watchForHolder();
    else stopOrphanWatch();
  };

  let resolveAttach!: (lib: ClientLibrary) => void;
  let rejectAttach!: (err: unknown) => void;
  const attach = new Promise<ClientLibrary>((resolve, reject) => {
    resolveAttach = resolve;
    rejectAttach = reject;
  });

  const onMessage = (message: Message) => {
    if (closed) return;
    const m = message as HolderMessage;
    if ('holder' in m && m.holder === holder) unanswered = 0;
    if ('holder' in m) heard();
    switch (m.type) {
      case 'opening':
        // A tab granted the lock, about to open: heard, above, and nothing else yet.
        return;
      case 'serving':
        // A holder other than the one this tab is attached to: the one before it has
        // gone, whether or not its `closing` arrived. One hello, from `detach`.
        if (m.holder !== holder) detach();
        return;
      case 'rows':
        if (m.client !== me) return;
        // A send started after the one in hand replaces it; a chunk of an earlier one
        // still on its way is not for the maps being filled.
        if (incoming && incoming.holder === m.holder && m.send < incoming.send) return;
        if (!incoming || incoming.holder !== m.holder || incoming.send !== m.send) incoming = { holder: m.holder, send: m.send, maps: freshMaps(), early: [] };
        for (const row of m.rows) incoming.maps[m.entity].rows.set((row as { id: string }).id, row as never);
        // The rows are on their way: no more hellos, unless `attached` never follows.
        stopAsking();
        stall = setTimeout(askNow, ATTACH_STALL_MS);
        // And a holder sending them is alive: the wait for one starts over.
        if (!holder) watchForHolder();
        return;
      case 'attached': {
        if (m.client !== me) return;
        // Rows that never came, or came from another holder: ask again. The end of a
        // send a later one replaced is not an attach.
        if (!incoming || incoming.holder !== m.holder) return sayHello();
        if (incoming.send !== m.send) return;
        maps = incoming.maps;
        // The changes the holder posted while its rows were on their way, over the
        // rows: a change the snapshot already holds comes out the same, and one it
        // does not is the holder's latest.
        for (const batches of incoming.early) apply(batches);
        holder = m.holder;
        incoming = null;
        stopOrphanWatch();
        if (pending.size > 0) startPinging();
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
        // the first answer. One that reached another holder and must not run twice is
        // refused instead.
        for (const [id, p] of pending) {
          if (p.sentTo === m.holder) continue;
          if (p.sentTo !== null && SEND_ONCE.has(p.name)) {
            pending.delete(id);
            p.reject(new CallUnsettledError(p.name));
            continue;
          }
          send(id, p);
        }
        if (!attachedOnce) {
          attachedOnce = true;
          resolveAttach(lib);
        }
        hooks.onAttached();
        return;
      }
      case 'changes':
        // Kept for a send on its way from this holder, attached to it already or not:
        // the snapshot that send took may predate this change.
        if (incoming?.holder === m.holder) incoming.early.push(m.batches);
        if (m.holder !== holder) return;
        apply(m.batches);
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
        if (pending.size === 0) stopPinging();
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

  const call = (name: CallName, args: unknown[]): Promise<unknown> => {
    if (closed) return Promise.reject(new LibraryMovedError(false));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const p: Pending = { name, args, sentTo: null, resolve, reject };
      pending.set(id, p);
      // Sent now when a holder is serving, and watched for an answer; else when the
      // next one attaches, which is waited for under the bound from now, if it was not
      // already.
      if (holder) {
        send(id, p);
        startPinging();
      } else if (!orphaned) watchForHolder();
    });
  };

  /** Told to the holder once, on close or when the page goes, so it stops forwarding for nobody. */
  let said = false;
  const sayBye = () => {
    if (said) return;
    said = true;
    try {
      port.post({ type: 'bye', client: me });
    } catch {
      // The channel is closed.
    }
  };
  /**
   * A page restored from the back/forward cache said bye on its way in: the holder
   * stopped counting it, and forwards nothing while it is the only client. Said hello
   * again, it is counted again and sent the rows it missed. Whether a browser keeps a
   * page with an open channel and a queued lock request in that cache is not known; the
   * listener costs nothing if none does.
   */
  const onShow = (event: PageTransitionEvent) => {
    if (!event.persisted || closed) return;
    said = false;
    // A send that was on its way when the page went is the holder's to have stopped; its
    // chunks, if any still come, are not the next send's.
    incoming = null;
    detach();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', sayBye);
    window.addEventListener('pageshow', onShow);
  }

  const close = async () => {
    if (closed) return;
    closed = true;
    stopAsking();
    stopPinging();
    stopOrphanWatch();
    stopListening();
    halting.removeEventListener('abort', onHalt);
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', sayBye);
      window.removeEventListener('pageshow', onShow);
    }
    sayBye();
    port.close();
    for (const p of pending.values()) p.reject(new LibraryMovedError(p.sentTo !== null));
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

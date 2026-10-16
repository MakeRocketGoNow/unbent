/**
 * The names the local store writes under, in one place, so that what opens a store and
 * what wipes one can never disagree about what is ours.
 *
 * Every name carries the account's id. The service worker's caches are keyed by address
 * and had to be emptied whenever the account on a device changed hands; the local store
 * is keyed by account instead, so two people who share a browser never share a file,
 * and the wipe on sign-out still removes every file with the prefix, in case the id of
 * the person leaving is not known (a session the server refused, say).
 */

/** The OPFS file an account's copy of its library lives in, and the prefix a wipe matches. */
export const STORE_PREFIX = 'unbent-';
/** The IndexedDB database the outbox keeps an account's pending writes in. */
export const OUTBOX_PREFIX = 'unbent-outbox-';
/**
 * The OPFS directory an account's file bytes live in (`store/files.ts`): the files of the
 * notebooks it chose to keep on this device, and the files added here that the server has
 * not taken yet. Beside the database rather than in the service worker's cache because
 * both are the account's and deliberate (a kept notebook is gigabytes someone confirmed,
 * a waiting upload exists nowhere else) and the cache goes on every account change, a
 * refused session included.
 */
export const FILES_PREFIX = 'unbent-files-';

/**
 * A user id as a file name. Better Auth's ids are short and alphanumeric, but OPFS names
 * are a file system's, and a character it refuses would refuse the whole store.
 */
const safe = (userId: string) => userId.replace(/[^A-Za-z0-9_-]/g, '_');

export const storeFileName = (userId: string) => `${STORE_PREFIX}${safe(userId)}.sqlite`;
/**
 * The OPFS file an account's search index lives in (`store/search-index.ts`), beside its
 * library. A store file by `isStoreFile`, so every wipe that removes the library removes
 * it, and named so it cannot be mistaken for another account's library: `safe` leaves no
 * dot in an id.
 */
export const searchFileName = (userId: string) => `${STORE_PREFIX}${safe(userId)}.search.sqlite`;
export const outboxName = (userId: string) => `${OUTBOX_PREFIX}${safe(userId)}`;
/**
 * The Web Lock the tab replaying an account's outbox holds (`store/leader.ts`). Named for
 * the account, not the origin: a window holding another account's library must not stop
 * this one's writes from going.
 */
export const outboxLeaderName = (userId: string) => `${OUTBOX_PREFIX}leader-${safe(userId)}`;
/** The Web Lock the one tab holding an account's library holds (`store/library-lock.ts`). */
export const libraryLockName = (userId: string) => `${STORE_PREFIX}library-${safe(userId)}`;
/**
 * The channel between the tab holding an account's library and the account's other tabs
 * (`store/library-channel.ts`). Per account for the lock's reason: a window on another
 * account must hear nothing of this one's rows.
 */
export const libraryChannelName = (userId: string) => `${STORE_PREFIX}library-channel-${safe(userId)}`;
export const filesDirName = (userId: string) => `${FILES_PREFIX}${safe(userId)}`;

/**
 * Whether an OPFS entry is one of ours: the database and the journal and WAL files SQLite
 * writes beside it. The access-handle pool directory wa-sqlite keeps (`.ahp-…`) is left
 * alone: it holds no rows of ours, and it belongs to the engine rather than to an account.
 */
export const isStoreFile = (name: string) => name.startsWith(STORE_PREFIX) && name.includes('.sqlite');
export const isOutbox = (name: string) => name.startsWith(OUTBOX_PREFIX);
export const isFilesDir = (name: string) => name.startsWith(FILES_PREFIX);

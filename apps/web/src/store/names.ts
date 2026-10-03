/**
 * The names the local store writes under, in one place, so that what opens a store and
 * what wipes one can never disagree about what is ours.
 *
 * Every name carries the account's id. The service worker's caches are keyed by address
 * and had to be emptied whenever the account on a device changed hands; the local store
 * is keyed by account instead, so two people who share a browser never share a file —
 * and the wipe on sign-out still removes every file with the prefix, in case the id of
 * the person leaving is not known (a session the server refused, say).
 */

/** The OPFS file an account's copy of its library lives in, and the prefix a wipe matches. */
export const STORE_PREFIX = 'unbent-';
/** The IndexedDB database the outbox keeps an account's pending writes in. */
export const OUTBOX_PREFIX = 'unbent-outbox-';

/**
 * A user id as a file name. Better Auth's ids are short and alphanumeric, but OPFS names
 * are a file system's, and a character it refuses would refuse the whole store.
 */
const safe = (userId: string) => userId.replace(/[^A-Za-z0-9_-]/g, '_');

export const storeFileName = (userId: string) => `${STORE_PREFIX}${safe(userId)}.sqlite`;
export const outboxName = (userId: string) => `${OUTBOX_PREFIX}${safe(userId)}`;

/**
 * Whether an OPFS entry is one of ours: the database and the journal and WAL files SQLite
 * writes beside it. The access-handle pool directory wa-sqlite keeps (`.ahp-…`) is left
 * alone: it holds no rows of ours, and it belongs to the engine rather than to an account.
 */
export const isStoreFile = (name: string) => name.startsWith(STORE_PREFIX) && name.includes('.sqlite');
export const isOutbox = (name: string) => name.startsWith(OUTBOX_PREFIX);

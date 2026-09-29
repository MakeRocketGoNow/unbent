import { AttachmentsRepo } from './attachments-repo.js';
import { NotesRepo } from './notes-repo.js';
import { storeFor } from './store-client.js';
import type { Env } from '../types.js';

/**
 * The repos for one user, bound to that user's store.
 *
 * This is the enforcement point for tenant isolation, as `new NotesRepo(env.DB, userId)`
 * was on the shared database: a handler receives repos already bound to a user and never
 * reaches for a store itself, so a request cannot address another account's object. The
 * object then refuses a database that is not its user's on every wake, which is the
 * check the shared database could never make.
 *
 * Both facades share one stub, so a request that uses both — the note and its files —
 * holds one connection to the object. Cheap and side-effect free: the notes router runs
 * it twice per request, once from its own `use` and once from a sub-route's.
 */
export function reposFor(
  env: Pick<Env, 'USER_STORE' | 'STORE_JURISDICTION'>,
  userId: string,
): { notes: NotesRepo; attachments: AttachmentsRepo } {
  const store = storeFor(env, userId);
  return { notes: new NotesRepo(store, userId), attachments: new AttachmentsRepo(store, userId) };
}

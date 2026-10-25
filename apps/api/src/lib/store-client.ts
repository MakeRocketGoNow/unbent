import { FREE_NOTES_FULL_CODE, InvalidFieldValue, PLAN_INACTIVE_CODE, STORAGE_FULL_CODE } from '@unbent/shared';
import type { UserStore } from '../store/user-store.js';
import type { Env } from '../types.js';
import { PlanRefused } from './free-plan.js';
import { StorageFull } from './quota.js';

/**
 * The Worker's side of the per-account note store: how a request reaches its user's
 * object, and what the errors that come back over RPC mean.
 *
 * `NotesRepo` and `AttachmentsRepo` are facades over one stub each, keeping the method
 * signatures every route, orchestrator and MCP tool was written against, so the cutover
 * to the object changed the two files that construct repos and nothing that uses them.
 * Every method is one RPC call; the composites on `UserStore` exist so a route that used
 * to make two or three calls to D1 still makes one to the object.
 */

/** The stub for `userId`'s store. Cheap, side-effect free, and called more than once per request. */
export function storeFor(env: Pick<Env, 'USER_STORE' | 'STORE_JURISDICTION'>, userId: string): DurableObjectStub<UserStore> {
  if (!userId) throw new Error('Refusing to reach a store without a user id');
  // Objects are keyed by user id and nothing else. The jurisdiction, when set, is part of
  // the key: `idFromName` on a jurisdiction namespace names a different object from the
  // same user id on the plain namespace. So it is set once, before an instance's first
  // account, and never changed: turning it on for a running instance would point every
  // account at a new, empty object, and turning it off would do the same. Recording a
  // jurisdiction per account in the directory would allow a change, at a D1 read per
  // request to find the store; not worth it for a setting a self-hoster decides once. No
  // `locationHint`: the platform places an object near its first request, and for a
  // personal note app that is where its user is.
  const namespace = env.STORE_JURISDICTION
    ? env.USER_STORE.jurisdiction(env.STORE_JURISDICTION as DurableObjectJurisdiction)
    : env.USER_STORE;
  return namespace.get(namespace.idFromName(userId));
}

/**
 * The store could not answer and will shortly: the object was reset by a deploy, is
 * overloaded, or the connection to it was lost. `onError` in index.ts turns this into a
 * 503 with `Retry-After`, the same answer `requireAuth` gives when the session cannot be
 * checked, and the only 503 the Android capture worker waits out rather than failing.
 */
export class StoreUnavailable extends Error {
  readonly retryAfterSeconds = 60;
  constructor(cause: unknown) {
    super(`The note store is unavailable right now: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'StoreUnavailable';
    this.cause = cause;
  }
}

/** Messages the runtime uses for the transient failures of a Durable Object call. */
const TRANSIENT = /overloaded|reset because its code was updated|transient|network connection lost|exceeded timeout|Durable Object reset|too many subrequests/i;

/**
 * An error that crossed the RPC boundary, turned back into what the caller expects.
 *
 * RPC keeps a thrown error's `name`, `message` and own properties but not its class
 * (measured 2026-09-29), so `instanceof InvalidFieldValue` in a route would be false for
 * the error the store threw. The field name survives as an own property, which is enough
 * to rebuild the real thing; the routes and the MCP tools then keep their `instanceof`.
 * Transient object failures become `StoreUnavailable`: the runtime's own (a reset, an
 * overload, a lost connection), which carry `retryable` or `overloaded` as own
 * properties, and an invocation that ran out of subrequests. Anything else passes
 * through as it arrived.
 */
export function translateStoreError(err: unknown): unknown {
  if (err && typeof err === 'object') {
    const e = err as {
      name?: unknown;
      message?: unknown;
      fieldName?: unknown;
      retryable?: unknown;
      overloaded?: unknown;
      code?: unknown;
      usedBytes?: unknown;
      quotaBytes?: unknown;
      addingBytes?: unknown;
      of?: unknown;
      notes?: unknown;
      attachmentBytes?: unknown;
      adding?: unknown;
    };
    if (e.name === 'InvalidFieldValue' && typeof e.fieldName === 'string') {
      return new InvalidFieldValue(e.fieldName, typeof e.message === 'string' ? e.message : '');
    }
    // The store's refusal of a file past the plan's storage (`StorageExceeded` in
    // store/attachments.ts), or of a note write past the store's own room (`StoreFull`
    // in store/user-store.ts, which says `of: 'notes'`), rebuilt as the Worker's own so
    // a route keeps `instanceof` and the sentence is the right bound's.
    if (e.code === STORAGE_FULL_CODE && typeof e.usedBytes === 'number' && typeof e.quotaBytes === 'number') {
      return new StorageFull(e.usedBytes, e.quotaBytes, typeof e.addingBytes === 'number' ? e.addingBytes : 0, e.of === 'notes' ? 'notes' : 'files');
    }
    // The free plan's refusal (`PlanRefusal` in store/user-store.ts): an account past
    // its limits, or a note past its count, rebuilt with the sentence that names them.
    if ((e.code === PLAN_INACTIVE_CODE || e.code === FREE_NOTES_FULL_CODE) && typeof e.notes === 'number' && typeof e.attachmentBytes === 'number') {
      return new PlanRefused(e.code, { notes: e.notes, attachmentBytes: e.attachmentBytes }, typeof e.adding === 'number' ? e.adding : 0);
    }
    if (e.retryable === true || e.overloaded === true) return new StoreUnavailable(err);
    if (typeof e.message === 'string' && TRANSIENT.test(e.message)) return new StoreUnavailable(err);
  }
  return err;
}

/**
 * Base for the two facades. `call` is the one place a stub is invoked, so every RPC
 * error passes through `translateStoreError` and the facades themselves are one line
 * per method.
 */
export abstract class StoreRepo {
  constructor(
    protected readonly store: DurableObjectStub<UserStore>,
    protected readonly userId: string,
  ) {
    if (!userId) throw new Error('Refusing to construct a repo without a user id');
  }

  protected async call<T>(fn: (store: DurableObjectStub<UserStore>) => Promise<T>): Promise<T> {
    try {
      return await fn(this.store);
    } catch (err) {
      throw translateStoreError(err);
    }
  }
}

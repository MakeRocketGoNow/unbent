import { ASSISTANT_GRANT_MAX_NOTEBOOKS } from '@unbent/shared';
import type { Bind } from './sql.js';

/**
 * What one connected assistant may reach of an account: some notebooks, and the notes
 * filed in none if `unfiled` says so (MAK-264). A connection given the whole library
 * has no `StoreAccess` at all, and every call it makes is the call anyone makes.
 *
 * The object does not keep this. The grant is the Worker's, in D1 beside the consent it
 * belongs to, where the check that already runs on every tool call reads it; it is
 * passed with each call, as a write's limits are, so an edit in Settings holds from the
 * next call and a deleted notebook leaves nothing here to clean up. An id naming no
 * notebook grants nothing: ids are never used twice.
 */
export interface StoreAccess {
  notebooks: string[];
  unfiled: boolean;
}


/**
 * A grant counted this small is the way into a page of notes; a larger one is tested
 * against notes read in the page's own order. See `NotesStore.filters`.
 *
 * Starting from the notebooks reads every note in them to sort a page out of (no index
 * orders several notebooks' notes together), so it costs the grant's size. Walking the
 * sort index and testing each note costs about a page times the library over the grant.
 * At a thousand, in the 13,000-note archive this is sized for, both are under a
 * thousand rows a page; either rule alone is the whole archive at its bad end.
 */
export const GRANT_DRIVEN_MAX = 1000;

/**
 * The grant in force for the call the object is running, if it runs for a restricted
 * connection; null for everyone else.
 *
 * Held here rather than passed down each method because of what a forgotten argument
 * would be. Passed, it is one more optional parameter on fifty methods across three
 * layers, and a call that leaves it out is an unrestricted call that looks like any
 * other. Held, it is set in one place (`UserStore.scoped`), every query that filters
 * notes reads it from one helper, and a method that was never taught about it cannot be
 * reached by a restricted connection at all. It is safe to hold because every data
 * method of the object is synchronous: the runtime gives the object to one call at a
 * time, and a call that never awaits cannot be interleaved with another, so the grant
 * set for one call is cleared before the next begins. `scoped` refuses a method that
 * answers with a promise for that reason.
 */
export class AccessScope {
  private access: StoreAccess | null = null;
  private counted: number | null = null;

  get current(): StoreAccess | null {
    return this.access;
  }

  /** The grant's size in notes, counted once a call: `count` is what reads it. */
  size(count: () => number): number {
    return (this.counted ??= count());
  }

  /** Runs `fn` under `access`, and under nothing again whatever it does. */
  within<T>(access: StoreAccess, fn: () => T): T {
    if (this.access) throw new Error('a restricted call cannot run inside another');
    this.access = access;
    this.counted = null;
    try {
      return fn();
    } finally {
      this.access = null;
      this.counted = null;
    }
  }
}

/** A grant as it arrived over RPC, checked: the Worker built it, but this is the side that trusts it. */
export function checkedAccess(value: unknown): StoreAccess {
  const v = value as { notebooks?: unknown; unfiled?: unknown } | null;
  if (
    !v ||
    typeof v !== 'object' ||
    !Array.isArray(v.notebooks) ||
    // Refused where a grant is saved, and here again: this is the side that would pay for it.
    v.notebooks.length > ASSISTANT_GRANT_MAX_NOTEBOOKS ||
    !v.notebooks.every((id) => typeof id === 'string') ||
    typeof v.unfiled !== 'boolean'
  ) {
    throw new Error('a restricted call needs its grant');
  }
  return { notebooks: v.notebooks as string[], unfiled: v.unfiled };
}

/**
 * The condition a note's notebook must meet under `access`, on `column`.
 *
 * One notebook is an equality, which the per-notebook indexes answer in order, so a
 * connection given a single notebook pages it as the app does. Several are one bind
 * holding their ids as JSON: a statement binds a hundred values and a grant may name
 * more. A grant of nothing at all is a condition nothing meets, which SQLite sees is
 * constant and reads no row for.
 *
 * `column` is `n.notebook_id` where the grant may be the way into the query and
 * `+n.notebook_id` where something else is (a tag, a list of ids, another notebook
 * condition, a sort index): the planner has no statistics and takes the first column of
 * an index to be selective, so left the choice it starts from the notebooks every time.
 * `filterConditions` says the same of its own notebook filter.
 */
export function accessCondition(access: StoreAccess, binds: Bind[], column: string): string {
  const parts: string[] = [];
  if (access.notebooks.length === 1) {
    binds.push(access.notebooks[0]!);
    parts.push(`${column} = ?${binds.length}`);
  } else if (access.notebooks.length > 1) {
    binds.push(JSON.stringify(access.notebooks));
    parts.push(`${column} IN (SELECT value FROM json_each(?${binds.length}))`);
  }
  if (access.unfiled) parts.push(`${column} IS NULL`);
  if (parts.length === 0) return '0';
  return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
}

export const ACCESS_REFUSED_CODE = 'ACCESS_REFUSED';

/**
 * Why a restricted connection's call was refused:
 *
 * - `notebook`: it named a notebook outside its grant, or one that does not exist, to
 *   file a note in. Not told apart, so a refusal does not say which names are taken.
 * - `unfiled`: it would have left a note in no notebook, and its grant does not cover
 *   those.
 * - `manage`: it asked for something that reaches past any one notebook (making or
 *   deleting a notebook, renaming or deleting a tag).
 * - `method`: it called something no rule here covers. Never a person's doing: a tool
 *   reached a store method that `UserStore.scoped` has not been taught, and the answer
 *   to that is a refusal by name, not an unrestricted call.
 */
export type AccessRefusalReason = 'notebook' | 'unfiled' | 'manage' | 'method';

/**
 * A restricted connection's call, refused. Own properties, as `StoreFull` has, since a
 * class does not cross RPC: the Worker reads `code` and `reason` off what arrived and
 * rebuilds its own `AccessRefused`, with the sentence an assistant can relay.
 *
 * What it cannot see is never refused, only missing: a note outside the grant is "no
 * such note" from every method, so a refusal says nothing about what exists.
 */
export class AccessRefusal extends Error {
  readonly code = ACCESS_REFUSED_CODE;
  constructor(
    readonly reason: AccessRefusalReason,
    detail = '',
  ) {
    super(`refused for a restricted connection: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'AccessRefusal';
  }
}

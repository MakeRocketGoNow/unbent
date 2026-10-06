// @ts-check
//
// The decision half of the nightly mirror prune, with no I/O in it. The workflow lists the
// live bucket and the mirror, reads the state file, calls `planPrune`, then deletes
// `remove` from the mirror and writes `state` back. Keeping the decision a pure function
// is what makes the dangerous part testable: every rule below is a deletion of a backup
// copy, and a test can run all of them without a bucket.
//
// The mirror keeps a file for 55 days after it leaves live, because a file deleted from
// live by mistake (or by a bug) has to be recoverable for longer than anyone is likely to
// take to notice. The state file is how "55 days gone" is counted: the mirror's own
// object dates say when a copy was written, not when its original disappeared, and a
// bucket lifecycle rule on the mirror would count from the copy's age, which would delete
// a file that is still live. So the date each key was first seen gone is written down.

/**
 * @typedef {{ version: 1, gone: Record<string, string> }} PruneState
 * `gone` maps a key to the UTC date (YYYY-MM-DD) on which a run first saw it in the
 * mirror and not in live.
 */

/** Days a key may be gone before the mirror's copy is deleted. */
export const GONE_DAYS = 55;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days since the epoch for a YYYY-MM-DD string. `Date.UTC` rather than `new Date(s)`
 * or local-time arithmetic: a runner's timezone or a daylight-saving change must never
 * make a day 23 or 25 hours long, which would move the day a backup is deleted.
 * @param {string} date
 */
function dayNumber(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${JSON.stringify(date)}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  // Date.UTC rolls 2026-02-31 over to March instead of refusing it; a state file with
  // such a date would silently shift a deletion, so round-trip and compare.
  if (new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new Error(`Not a real calendar date: ${JSON.stringify(date)}`);
  }
  return ms / DAY_MS;
}

/** @param {string[]} keys */
function sorted(keys) {
  // Plain code-unit order, not localeCompare: the result is written to a file that is
  // diffed between runs, and a locale-dependent order would differ between machines.
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * @param {{ live: string[], mirror: string[], state: PruneState | null | undefined, today: string }} input
 * @returns {{ remove: string[], state: PruneState }}
 */
export function planPrune({ live, mirror, state, today }) {
  // An empty or missing live listing is far more likely a failed listing (a permissions
  // change, a wrong bucket, an outage that returned nothing) than a library with no
  // files. Planning against it would mark the whole mirror gone, and 55 days later
  // delete it. The caller treats the throw as "fail the run, leave the state file alone".
  if (!Array.isArray(live) || live.length === 0) {
    throw new Error(
      'The live listing is empty or missing; refusing to plan a prune against it.',
    );
  }
  if (!Array.isArray(mirror)) throw new Error('The mirror listing is missing.');
  if (state != null && state.version !== 1) {
    throw new Error(`Unknown prune state version: ${String(state.version)}`);
  }

  const todayNumber = dayNumber(today);
  const liveSet = new Set(live);
  const mirrorSet = new Set(mirror);
  const previous = state?.gone ?? {};

  /** @type {Record<string, string>} */
  const nextGone = {};
  /** @type {string[]} */
  const remove = [];

  // Only keys in the mirror and not in live are candidates. That one loop also drops, by
  // never carrying them over, a key that reappeared in live (it is no longer gone) and a
  // key that is in neither listing (already deleted from the mirror by someone else, so
  // there is nothing left to wait for or to delete).
  for (const key of mirrorSet) {
    if (liveSet.has(key)) continue;
    const since = Object.hasOwn(previous, key) ? previous[key] : today;
    if (todayNumber - dayNumber(since) >= GONE_DAYS) {
      // Deleted from the mirror, so it is left out of the new state too: the next run
      // will not find it in the mirror, and a stale entry would only be dropped then.
      remove.push(key);
    } else {
      nextGone[key] = since;
    }
  }

  /** @type {Record<string, string>} */
  const gone = {};
  for (const key of sorted(Object.keys(nextGone))) gone[key] = nextGone[key];
  return { remove: sorted(remove), state: { version: 1, gone } };
}

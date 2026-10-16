import type { DumpStatus, MirrorStatus } from '@unbent/shared';
import { timeAgo } from './components/format-when.js';

/**
 * What the operator page says of each half of the backup, worked out from the status
 * file that half leaves in the bucket. Pure, so the four states can be pinned without a
 * render; the card draws the word, and the reasons under it when the word is a bad one.
 *
 * Four states, one word each, and the order they are decided in matters:
 *
 * - `never`: no file. The bucket is bound and the run has not happened yet: the first
 *   dump run after a deploy, or a mirror whose first dispatch is still to come. Plain,
 *   not red: nothing has failed.
 * - `failed`: the run says so. A dump run with failing accounts, a mirror that was not
 *   `ok`. Decided before staleness, because a failed run that is also old is a failure
 *   first; "stale" would send the reader looking at the cron when the file names the
 *   fault.
 * - `stale`: the last run is older than the window (the file's own `staleAfterHours`
 *   for dumps, two nights for the mirror) or, for dumps, an account no run has found
 *   current in that long. The cron has stopped, the binding has gone, or an account is
 *   being skipped.
 * - `healthy`: ran inside the window, and nothing failed.
 */
export type HealthState = 'never' | 'healthy' | 'failed' | 'stale';

export interface Health {
  state: HealthState;
  /** The bad state's reasons, one line each; empty when healthy or never run. */
  reasons: string[];
}

/** The mirror runs nightly; a second missed night is when its silence means something. */
export const MIRROR_STALE_HOURS = 48;

/**
 * `nameOf` turns an account id in the file into what the page calls the account (its
 * email, once the directory has been read), so a reason names who, not a 32-character
 * id to match against the table by eye. The file itself carries ids only.
 */
export function dumpsHealth(status: DumpStatus | null, now = Date.now(), nameOf: (userId: string) => string = (id) => id): Health {
  if (!status) return { state: 'never', reasons: [] };
  const reasons: string[] = [];
  if (status.failingCount > 0) {
    reasons.push(`${count(status.failingCount, 'account')} failed to dump.`);
    for (const f of status.failing) reasons.push(`${nameOf(f.userId)}: ${f.error}`);
    return { state: 'failed', reasons };
  }
  const ranAt = Date.parse(status.ranAt);
  const window = status.staleAfterHours * 3_600_000;
  if (Number.isNaN(ranAt)) {
    reasons.push('The status file has no readable time for its last run.');
  } else if (now - ranAt > window) {
    reasons.push(`The last run was ${timeAgo(ranAt, now)}, over ${status.staleAfterHours} hours; the cron has stopped or the bucket binding has gone.`);
  }
  if (status.staleCount > 0) {
    reasons.push(`${count(status.staleCount, 'account')} ${status.staleCount === 1 ? 'has' : 'have'} no dump found current in ${status.staleAfterHours} hours: ${status.stale.map(nameOf).join(', ')}.`);
  }
  return reasons.length ? { state: 'stale', reasons } : { state: 'healthy', reasons };
}

export function mirrorHealth(status: MirrorStatus | null, now = Date.now()): Health {
  if (!status) return { state: 'never', reasons: [] };
  const reasons: string[] = [];
  if (!status.ok) {
    reasons.push(
      status.outcome === 'cancelled'
        ? 'The run was cancelled before it finished.'
        : status.failedSteps.length
          ? `Failed at: ${status.failedSteps.join(', ')}.`
          : 'The run failed, and no step recorded why.',
    );
    for (const copy of [status.blobs, status.stores]) for (const line of copy.errorLines) reasons.push(line);
    if (status.dumps && !status.dumps.ok) for (const r of status.dumps.reasons) reasons.push(r);
    return { state: 'failed', reasons };
  }
  const ranAt = Date.parse(status.ranAt);
  if (Number.isNaN(ranAt)) {
    reasons.push('The status file has no readable time for its last run.');
  } else if (now - ranAt > MIRROR_STALE_HOURS * 3_600_000) {
    reasons.push(`The last run was ${timeAgo(ranAt, now)}, over ${MIRROR_STALE_HOURS} hours; the workflow has not run since.`);
  }
  return reasons.length ? { state: 'stale', reasons } : { state: 'healthy', reasons };
}

/** The word the card leads with. */
export const HEALTH_WORD: Record<HealthState, string> = {
  never: 'Never run',
  healthy: 'Healthy',
  failed: 'Failed',
  stale: 'Stale',
};

function count(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

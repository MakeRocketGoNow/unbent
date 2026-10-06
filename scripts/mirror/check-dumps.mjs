// @ts-check
//
// Reads the `status/dumps.json` the Worker's daily dump run writes (`lib/backups.ts`) and
// decides whether the Worker's half of the backup is healthy. The mirror only copies what
// the Worker dumped, so a dump that failed or an account nobody has dumped for two days is
// a hole in the backup that nothing else would make visible: the mirror workflow fails on
// it so the hole is a red run in GitHub rather than a line in a file nobody opens.
//
//   node scripts/mirror/check-dumps.mjs dumps.json out.json
//
// Writes the result to `out.json` — ok, what was read, and the reasons when not ok — for
// `status/mirror.json`, logs the counts, and exits 1 when the run should fail. The reasons
// name accounts and quote the Worker's error text, so they go to the file and not to the
// log: the run log of an open-source repository is public, and a dump's error can carry
// anything. A missing file is a reason too (the Worker has never run with a backups bucket
// bound, or the bucket is the wrong one), so the caller fetches the file without failing
// on absence and lets this say so.

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * How old the last run may be before the status itself is stale: the issue's 48 hours,
 * the same window the Worker uses for an account. The cron runs hourly, so a status this
 * old means the cron has stopped or the bucket binding has gone.
 */
const STALE_HOURS = 48;

const [path, out] = process.argv.slice(2);
if (!path || !out) throw new Error('Usage: check-dumps.mjs <dumps.json> <out.json>');

/** @type {string[]} */
const reasons = [];
/** @type {any} */
let status = null;
try {
  status = JSON.parse(readFileSync(path, 'utf8'));
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
  reasons.push(
    code === 'ENOENT'
      ? 'status/dumps.json is not in the dumps bucket: the Worker has not written one'
      : `status/dumps.json could not be read: ${err instanceof Error ? err.message : String(err)}`,
  );
}

let ageHours = null;
if (status) {
  const ranAt = Date.parse(status.ranAt);
  if (Number.isNaN(ranAt)) {
    reasons.push(`status/dumps.json has no readable ranAt: ${JSON.stringify(status.ranAt)}`);
  } else {
    ageHours = Math.round(((Date.now() - ranAt) / 3_600_000) * 10) / 10;
    if (ageHours > STALE_HOURS) {
      reasons.push(`the last dump run was ${ageHours} hours ago, over ${STALE_HOURS}`);
    }
  }
  if (typeof status.failingCount !== 'number' || typeof status.staleCount !== 'number') {
    reasons.push('status/dumps.json has no failingCount or staleCount');
  } else {
    if (status.failingCount > 0) {
      const named = (status.failing ?? []).map((/** @type {any} */ f) => `${f.userId}: ${f.error}`);
      reasons.push(`${status.failingCount} account(s) failed to dump: ${named.join('; ')}`);
    }
    if (status.staleCount > 0) {
      reasons.push(
        `${status.staleCount} account(s) have no dump found current in ${status.staleAfterHours ?? STALE_HOURS} hours: ${(status.stale ?? []).join(', ')}`,
      );
    }
  }
}

const result = {
  ok: reasons.length === 0,
  ranAt: status?.ranAt ?? null,
  ageHours,
  accounts: status?.accounts ?? null,
  failingCount: status?.failingCount ?? null,
  staleCount: status?.staleCount ?? null,
  reasons,
};
writeFileSync(out, `${JSON.stringify(result)}\n`);
console.log(
  result.ok
    ? `The Worker's dumps are healthy: last run ${result.ageHours} hours ago, ${result.accounts} accounts, none failing or stale.`
    : `The Worker's dumps are not healthy: ${result.reasons.length} reason(s), ${result.failingCount ?? '?'} failing, ${result.staleCount ?? '?'} stale, last run ${result.ageHours ?? '?'} hours ago. The reasons are in status/mirror.json.`,
);
if (!result.ok) process.exit(1);

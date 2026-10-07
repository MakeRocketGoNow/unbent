// @ts-check
//
// Composes `status/mirror.json`, what the night's mirror run did, from the files the
// workflow's steps left in one directory, so the operator page (MAK-171 part 5) and a
// person with `rclone cat` can see the off-account half of the backup without opening a
// GitHub run. It runs whether the job passed or failed: a failed run is exactly the one
// the file must report, and a step that never ran leaves its file missing, which reads
// here as `null` rather than as an error.
//
//   node scripts/mirror/write-status.mjs <dir> <out.json> <summary.md>
//
// With, in <dir>, whichever of these the run got as far as writing:
//   blobs.log, stores.log   rclone's JSON log of each copy (--use-json-log); the last line
//                           carrying a `stats` object is the final tally
//   d1.json                 { key, bytes, written } from the D1 export step
//   prune.json              the summary `prune.mjs` printed
//   dumps-check.json        the result `check-dumps.mjs` wrote
//   failed                  one line per step that failed, written by each step's EXIT trap
// and the run's identity and outcome in the environment: MIRROR_RAN_AT, MIRROR_OK
// ("true"/"false"), MIRROR_JOB_STATUS (GitHub's `job.status`: success, failure or
// cancelled — a run killed by its timeout or cancelled by hand fires no step's trap, so
// this is the only word the file has for it), MIRROR_EVENT, MIRROR_RUN_ID and
// MIRROR_RUN_URL.
//
// The summary is the counts alone, for the run page. The file has the account ids and
// error text the operator page needs; the run page of an open-source repository is
// public, so those stay in the bucket.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, out, summary] = process.argv.slice(2);
if (!dir || !out || !summary) throw new Error('Usage: write-status.mjs <dir> <out.json> <summary.md>');

/** @param {string} name */
function readJson(name) {
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  // The checks print one JSON line each; a step that was cut off may have left nothing.
  return text ? JSON.parse(text) : null;
}

/** Error lines of a copy kept in the status; the count is whole. */
const ERRORS_KEPT = 5;

/**
 * The final tally of an rclone copy, and the first few errors. rclone prints its stats as
 * a log line with a `stats` object when `--use-json-log` is on; the last such line is the
 * one at exit. Its errors are lines at level `error`, each naming its object, and they
 * are kept here because the log file itself is thrown away with the runner: the run's
 * log must not carry a customer's filename, and this file, in the private dumps bucket,
 * is where the operator reads why a copy failed. Anything else in the log, including
 * lines that are not JSON, is ignored, and a log with no tally gives nulls, never a
 * failed status write.
 * @param {string} name
 */
function copyStats(name) {
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  /** @type {any} */
  let last = null;
  /** @type {string[]} */
  const errorLines = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object') continue;
      if (entry.stats) last = entry.stats;
      if (entry.level === 'error' && errorLines.length < ERRORS_KEPT) {
        errorLines.push(entry.object ? `${entry.object}: ${entry.msg}` : String(entry.msg));
      }
    } catch {
      // Not a JSON line after all; rclone's own output, not ours to fail on.
    }
  }
  return {
    copied: typeof last?.transfers === 'number' ? last.transfers : null,
    bytes: typeof last?.bytes === 'number' ? last.bytes : null,
    errors: typeof last?.errors === 'number' ? last.errors : null,
    errorLines,
  };
}

const prune = readJson('prune.json');
const failedPath = join(dir, 'failed');
const failedSteps = existsSync(failedPath)
  ? readFileSync(failedPath, 'utf8').split('\n').filter((line) => line.length > 0)
  : [];
const status = {
  // `ranAt` is when the run started and `finishedAt` when this was written; a seed is
  // hours between the two.
  ranAt: process.env.MIRROR_RAN_AT ?? new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  ok: process.env.MIRROR_OK === 'true',
  outcome: process.env.MIRROR_JOB_STATUS ?? (process.env.MIRROR_OK === 'true' ? 'success' : 'failure'),
  failedSteps,
  run: {
    event: process.env.MIRROR_EVENT ?? null,
    id: process.env.MIRROR_RUN_ID ?? null,
    url: process.env.MIRROR_RUN_URL ?? null,
  },
  blobs: {
    ...(copyStats('blobs.log') ?? { copied: null, bytes: null, errors: null, errorLines: [] }),
    live: prune?.live ?? null,
    mirror: prune?.mirror ?? null,
  },
  stores: copyStats('stores.log') ?? { copied: null, bytes: null, errors: null, errorLines: [] },
  d1: readJson('d1.json'),
  prune: prune ? { gone: prune.gone, pruned: prune.pruned, goneDays: prune.goneDays } : null,
  dumps: readJson('dumps-check.json'),
};

writeFileSync(out, `${JSON.stringify(status, null, 2)}\n`);

/** @param {unknown} n */
const count = (n) => (typeof n === 'number' ? String(n) : '?');
const lines = [
  `## Mirror ${status.ok ? 'ran' : status.outcome === 'cancelled' ? 'was cancelled' : 'failed'} (${status.run.event})`,
  '',
  status.ok ? null : `Failed steps: ${failedSteps.join(', ') || 'none recorded'}`,
  `- Files: ${count(status.blobs.copied)} copied, ${count(status.blobs.live)} live, ${count(status.blobs.mirror)} mirrored`,
  `- Dumps: ${count(status.stores.copied)} copied`,
  `- D1: ${status.d1 ? `${status.d1.key}, ${count(status.d1.bytes)} bytes${status.d1.written ? '' : ' (already there)'}` : 'not exported'}`,
  `- Prune: ${count(status.prune?.gone)} gone, ${count(status.prune?.pruned)} pruned`,
  `- Worker's dumps: ${status.dumps ? (status.dumps.ok ? 'healthy' : `${status.dumps.reasons.length} reason(s) in status/mirror.json`) : 'not checked'}`,
].filter((line) => line !== null);
writeFileSync(summary, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));

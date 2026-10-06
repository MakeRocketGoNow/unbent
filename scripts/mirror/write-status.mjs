// @ts-check
//
// Composes `status/mirror.json`, what the night's mirror run did, from the files the
// workflow's steps left in one directory, so the operator page (MAK-171 part 5) and a
// person with `rclone cat` can see the off-account half of the backup without opening a
// GitHub run. It runs whether the job passed or failed: a failed run is exactly the one
// the file must report, and a step that never ran leaves its file missing, which reads
// here as `null` rather than as an error.
//
//   node scripts/mirror/write-status.mjs <dir> <out.json>
//
// With, in <dir>, whichever of these the run got as far as writing:
//   blobs.log, stores.log   rclone's JSON log of each copy (--use-json-log); the last line
//                           carrying a `stats` object is the final tally
//   d1.json                 { key, bytes, written } from the D1 export step
//   prune.json              the summary `prune.mjs` printed
//   dumps-check.json        the result `check-dumps.mjs` printed
// and the run's identity and outcome in the environment: MIRROR_RAN_AT, MIRROR_OK
// ("true"/"false"), MIRROR_FAILED_STEP (the step the run was in when it failed, if it
// did), MIRROR_EVENT, MIRROR_RUN_ID and MIRROR_RUN_URL.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error('Usage: write-status.mjs <dir> <out.json>');

/** @param {string} name */
function readJson(name) {
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').trim();
  // The checks print one JSON line each; a step that was cut off may have left nothing.
  return text ? JSON.parse(text) : null;
}

/**
 * The final tally of an rclone copy. rclone prints its stats as a log line with a
 * `stats` object when `--use-json-log` is on; the last such line is the one at exit.
 * Anything else in the log, including lines that are not JSON, is ignored, and a log
 * with no tally gives nulls, never a failed status write.
 * @param {string} name
 */
function copyStats(name) {
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  /** @type {any} */
  let last = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && entry.stats) last = entry.stats;
    } catch {
      // Not a JSON line after all; rclone's own output, not ours to fail on.
    }
  }
  return {
    copied: typeof last?.transfers === 'number' ? last.transfers : null,
    bytes: typeof last?.bytes === 'number' ? last.bytes : null,
    errors: typeof last?.errors === 'number' ? last.errors : null,
  };
}

const prune = readJson('prune.json');
const status = {
  ranAt: process.env.MIRROR_RAN_AT ?? new Date().toISOString(),
  ok: process.env.MIRROR_OK === 'true',
  failedStep: process.env.MIRROR_OK === 'true' ? null : (process.env.MIRROR_FAILED_STEP || null),
  run: {
    event: process.env.MIRROR_EVENT ?? null,
    id: process.env.MIRROR_RUN_ID ?? null,
    url: process.env.MIRROR_RUN_URL ?? null,
  },
  blobs: {
    ...(copyStats('blobs.log') ?? { copied: null, bytes: null, errors: null }),
    live: prune?.live ?? null,
    mirror: prune?.mirror ?? null,
  },
  stores: copyStats('stores.log') ?? { copied: null, bytes: null, errors: null },
  d1: readJson('d1.json'),
  prune: prune ? { gone: prune.gone, pruned: prune.pruned, goneDays: prune.goneDays } : null,
  dumps: readJson('dumps-check.json'),
};

writeFileSync(out, `${JSON.stringify(status, null, 2)}\n`);
console.log(JSON.stringify(status, null, 2));

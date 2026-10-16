// @ts-check
//
// The step summary of a restore-files run (.github/workflows/restore-files.yml): what
// `rclone copy` from the mirror back to the live bucket did, read from its JSON log the
// way write-status.mjs reads the mirror's. Counts only: a file's key is a customer's
// filename, and the run page of an open-source repository is public.
//
//   node scripts/mirror/restore-summary.mjs <copy.log> <summary.md>
//
// With the account id, the mirror's count for its prefix and whether the run was a dry
// run in the environment: RESTORE_ACCOUNT, RESTORE_MIRRORED, RESTORE_DRY_RUN.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The final tally of an rclone copy run with `--use-json-log`: the last log line that
 * carries a `stats` object. `transfers` is what was copied; `checks` what was looked at
 * and left alone, which under `--ignore-existing` is every file already in live; `errors`
 * what failed. A log with no tally (a copy that died before its first stats line)
 * gives nulls, never a failed summary.
 * @param {string} text
 */
export function copyTally(text) {
  /** @type {any} */
  let last = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && entry.stats) last = entry.stats;
    } catch {
      // Not a JSON line after all; rclone's own output, not ours to fail on.
    }
  }
  const n = (/** @type {unknown} */ v) => (typeof v === 'number' ? v : null);
  return { copied: n(last?.transfers), bytes: n(last?.bytes), skipped: n(last?.checks), errors: n(last?.errors) };
}

/**
 * The lines of the summary.
 * @param {{ account: string; mirrored: number | null; dryRun: boolean }} run
 * @param {ReturnType<typeof copyTally>} tally
 */
export function summaryLines(run, tally) {
  const count = (/** @type {unknown} */ v) => (typeof v === 'number' ? String(v) : '?');
  return [
    `## ${run.dryRun ? 'Would restore' : 'Restored'} files of account ${run.account}`,
    '',
    `- In the mirror: ${count(run.mirrored)} file(s) under its prefix`,
    `- ${run.dryRun ? 'Would copy' : 'Copied'}: ${count(tally.copied)} file(s), ${count(tally.bytes)} bytes`,
    `- Already in the live bucket, left alone: ${count(tally.skipped)}`,
    `- Errors: ${count(tally.errors)}`,
    '',
    run.dryRun ? 'Dispatch again with `confirm` set to `RESTORE` to copy them.' : 'Nothing was deleted or overwritten; a file already in the live bucket was left as it was.',
  ];
}

// The functions are exported for the test; the file is also the command the workflow runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [log, out] = process.argv.slice(2);
  if (!log || !out) throw new Error('Usage: restore-summary.mjs <copy.log> <summary.md>');
  const mirrored = Number(process.env.RESTORE_MIRRORED);
  const lines = summaryLines(
    {
      account: process.env.RESTORE_ACCOUNT ?? '?',
      mirrored: Number.isFinite(mirrored) ? mirrored : null,
      dryRun: process.env.RESTORE_DRY_RUN === 'true',
    },
    copyTally(readFileSync(log, 'utf8')),
  );
  writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

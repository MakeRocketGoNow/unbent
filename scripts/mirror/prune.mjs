// @ts-check
//
// The I/O half of the nightly mirror prune: reads the two listings and the previous
// state the workflow fetched with rclone, asks `planPrune` what to do, and writes the
// keys to delete and the new state for the workflow to send back with rclone. It never
// talks to a bucket itself, so the only thing that can delete a copy is a line in
// `--remove`, which the test on the planner covers.
//
//   node scripts/mirror/prune.mjs --live live.txt --mirror mirror.txt \
//     [--state state.json] --today YYYY-MM-DD --remove remove.txt --new-state state.json
//
// The listings are `rclone lsf -R --files-only` output: one key per line, relative to
// the bucket (live) or to `blobs/` (mirror). `--state` is optional and absent on the
// first run. A summary is printed as one JSON line for the run's status file.

import { readFileSync, writeFileSync } from 'node:fs';
import { GONE_DAYS, planPrune } from './prune-plan.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value pairs, got ${JSON.stringify(argv)}`);
    }
    args[name.slice(2)] = value;
  }
  return args;
}

/** @param {string} path */
function readListing(path) {
  // A trailing newline is not an empty key, and an empty file is an empty listing, which
  // the planner refuses for the live side.
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
}

const args = parseArgs(process.argv.slice(2));
for (const required of ['live', 'mirror', 'today', 'remove', 'new-state']) {
  if (!(required in args)) throw new Error(`Missing --${required}`);
}

const live = readListing(args.live);
const mirror = readListing(args.mirror);
const state = args.state ? JSON.parse(readFileSync(args.state, 'utf8')) : null;

const plan = planPrune({ live, mirror, state, today: args.today });

writeFileSync(args.remove, plan.remove.map((key) => `${key}\n`).join(''));
writeFileSync(args['new-state'], `${JSON.stringify(plan.state, null, 2)}\n`);

console.log(
  JSON.stringify({
    live: live.length,
    mirror: mirror.length,
    gone: Object.keys(plan.state.gone).length,
    pruned: plan.remove.length,
    goneDays: GONE_DAYS,
  }),
);

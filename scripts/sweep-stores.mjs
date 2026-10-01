#!/usr/bin/env node
/**
 * Runs one whole pass of the note-store sweep against a deployed instance, and fails if any
 * account's store failed to wake.
 *
 * The last step of a deploy. A schema file appended to `SCHEMA` is applied to each account's
 * store the next time something wakes it, and the sweep (apps/api/src/lib/sweep.ts) is what
 * wakes them all; without this step that happened on the next hourly cron, or when someone
 * remembered the runbook. Run here, a migration that breaks one account turns the deploy
 * red, minutes after it shipped, rather than being found by that account's owner.
 *
 *   SWEEP_TOKEN=… node scripts/sweep-stores.mjs --origin https://example.com
 *   SWEEP_TOKEN=… node scripts/sweep-stores.mjs --wrangler-output deploy.ndjson
 *
 * `--origin` wins when it is non-empty. Otherwise the address comes from the file wrangler
 * writes when `WRANGLER_OUTPUT_FILE_PATH` is set: the deploy's own record of where it
 * went, so a fork whose only address is its workers.dev name needs nothing configured.
 *
 * Each call is one batch — twenty accounts, since an invocation has fifty subrequests on
 * Workers Free — and the answer says whether the pass is `done`, so this calls until it
 * is. The first call says `?restart=1`: the cursor is shared with the hourly cron and is
 * usually partway down the directory, and a pass resumed from there would report done
 * without having visited the accounts above it. A cron batch landing mid-pass still moves
 * the same cursor and skips this pass past twenty accounts; those were swept, by the
 * cron, and only their counts are missing from the report here.
 *
 * Only counts are printed. The Actions log of a public repository is public, and the ids
 * of the accounts that failed are already in the Worker's log beside the error, which is
 * where anyone fixing them has to look anyway.
 *
 * `deferred` — a store the runtime asked to be called again — is a warning, not a
 * failure: it is the runtime's transient, and the next cron visits it.
 */
import { readFileSync, appendFileSync } from 'node:fs';

const HEADER = 'X-Unbent-Sweep-Token';

/** A pass over more accounts than this many batches is a cursor that never ends, not a big instance. */
const MAX_BATCHES = 500;

/**
 * How long one batch is retried for. Right after `wrangler deploy` the previous version
 * can still answer for a few seconds, and it may not know this token — or, before this
 * step first shipped, the header at all (a 401 then). Those, a 5xx and a dropped
 * connection are retried; anything else fails at once.
 */
const ATTEMPTS = 8;
const RETRY_MS = 10_000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/**
 * The first address wrangler recorded for the deploy: a workers.dev URL, which it writes
 * with its scheme, or a custom domain, which it writes as `host (custom domain…)`. Cron
 * targets (`schedule: …`) and zone routes with wildcards are not addresses.
 */
function originFromWranglerOutput(path) {
  const entries = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const targets = entries.filter((e) => e.type === 'deploy').flatMap((e) => e.targets ?? []);
  for (const target of targets) {
    if (target.startsWith('https://')) return target;
    const custom = /^([a-z0-9.-]+) \(custom domain\b/i.exec(target);
    if (custom) return `https://${custom[1]}`;
  }
  return undefined;
}

async function batch(url, token) {
  let last = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { [HEADER]: token } });
      if (res.ok) return await res.json();
      last = `answered ${res.status}`;
      if (![401, 404].includes(res.status) && res.status < 500) break;
    } catch (err) {
      last = `could not be reached (${err instanceof Error ? err.message : err})`;
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_MS));
  }
  fail(
    `The sweep ${last}. A 404 that never clears means the Worker has a different SWEEP_TOKEN, or none — the deploy carries it from the repository secret.`,
  );
}

const token = process.env.SWEEP_TOKEN?.trim();
if (!token) fail('SWEEP_TOKEN is not set.');

const outputFile = arg('--wrangler-output');
const origin = arg('--origin')?.trim() || (outputFile ? originFromWranglerOutput(outputFile) : undefined);
if (!origin) fail('No address to sweep: pass --origin, or --wrangler-output from a deploy that recorded one.');

const url = new URL('/api/admin/store/sweep', origin).toString();
const totals = { batches: 0, visited: 0, wiped: 0, dropped: 0, failed: 0, deferred: 0 };
let done = false;
while (!done) {
  if (totals.batches >= MAX_BATCHES) fail(`The sweep was not done after ${MAX_BATCHES} batches.`);
  const report = await batch(totals.batches === 0 ? `${url}?restart=1` : url, token);
  totals.batches += 1;
  totals.visited += report.visited;
  totals.wiped += report.wiped;
  totals.dropped += report.dropped;
  totals.failed += report.failed.length;
  totals.deferred += report.deferred.length;
  done = report.done;
}

const line = `Swept ${totals.visited} accounts in ${totals.batches} batches: ${totals.failed} failed, ${totals.deferred} deferred, ${totals.wiped} wiped, ${totals.dropped} dropped.`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
if (totals.deferred > 0) {
  console.log(`::warning::${totals.deferred} account stores asked to be called again; the hourly cron will.`);
}
if (totals.failed > 0) {
  fail(`${totals.failed} account stores failed to wake. The Worker's log has each one as "[store] sweep failed for user=…".`);
}

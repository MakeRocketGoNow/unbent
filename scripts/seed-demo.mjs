#!/usr/bin/env node
/**
 * Sample notes on a local instance: for trying a branch against something real-shaped,
 * and for screenshots.
 *
 * What it loads is `packages/seed/` — ten presentable notes, five notebooks with every kind
 * of custom field and a few dozen invented records in each, receipts with PDF and image
 * scans whose text is searchable, the cases that have broken a layout before, a few notes
 * in the trash, and three hundred generated notes behind them for volume. Nothing in it
 * is anybody's; see the header of `packages/seed/src/records.mjs`. `--small` loads only the ten, for
 * the store screenshots, which are of those.
 *
 * No credential is stored anywhere. The password below is a constant in a script that
 * refuses to run against anything but localhost, and the account it makes lives in a
 * disposable local D1; a saved one would only drift out of sync with the next `--fresh`
 * worktree or `migrate:local`. Sign-up works because `pnpm dev` passes
 * `ALLOW_TEST_CREDENTIALS=1` to the Worker, which turns on password auth for local
 * development — the same switch the API test suite mints its sessions with. See the
 * comment on `passwordEnabled` in `apps/api/src/auth.ts`.
 *
 * Idempotent: run it twice and you get the same notes, not twice as many. Each note is
 * found again by its key in the seed, so editing one there and re-running updates it in
 * place. An account seeded before the seed had keys gets a second copy of the ten; run
 * once with `--reset` to start clean.
 *
 *   pnpm seed:demo                     # this checkout's dev server
 *   pnpm seed:demo --url http://localhost:5173
 *   pnpm seed:demo --small             # only the ten showcase notes
 *   pnpm seed:demo --reset             # delete the demo account's notes first, trash included
 */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { portsFor } from './ports.mjs';
import { clearNotes, loadSeed } from '../packages/seed/src/load.mjs';

const EMAIL = 'demo@example.com';
const PASSWORD = 'demo-password-1234';
const NAME = 'Demo';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

/**
 * The instance to seed: `--url`, else this checkout's own dev server.
 *
 * Derived rather than hardcoded because a worktree's ports are derived — see
 * `scripts/ports.mjs`. Hardcoding 5173 would seed the main checkout from a worktree, which
 * is the one mistake this script must not make quietly.
 */
function baseUrl() {
  const explicit = arg('--url');
  if (explicit) return explicit.replace(/\/$/, '');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    encoding: 'utf8',
  }).trim();
  return `http://localhost:${portsFor(root).web}`;
}

/**
 * Refuse anything that is not loopback.
 *
 * This script signs up an account with a password that is written down in it. Pointed at a
 * deployed instance that had password auth on, it would create a real account on it with a
 * known credential. Nothing here needs to reach a remote host, so the check is a flat no
 * rather than a prompt.
 */
function assertLocal(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`--url must be a URL, got: ${url}`);
  }
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(
      `Refusing to seed ${url}: this script signs up a known password and is local-only. ` +
        `See the comment on \`passwordEnabled\` in apps/api/src/auth.ts.`,
    );
  }
}

const BASE = baseUrl();
assertLocal(BASE);

/**
 * `Origin` is sent on every request, because Better Auth rejects a request without one as
 * cross-site (`MISSING_OR_NULL_ORIGIN`). A browser sets it; `fetch` here does not, so the
 * auth endpoints 403 without this. The API tests pass it for the same reason.
 */
async function api(path, { method = 'GET', body, cookie } = {}) {
  return request(path, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    cookie,
  });
}

function request(path, { cookie, headers, ...init } = {}) {
  return fetch(BASE + path, {
    ...init,
    headers: { Origin: BASE, ...headers, ...(cookie ? { Cookie: cookie } : {}) },
  });
}

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0] ?? null;
}

/** Sign up, or sign in if the account is already there from a previous run. */
async function session() {
  const up = await api('/api/auth/sign-up/email', {
    method: 'POST',
    body: { email: EMAIL, password: PASSWORD, name: NAME },
  });
  if (up.ok) {
    const cookie = cookieFrom(up);
    if (!cookie) throw new Error('sign-up returned no session cookie');
    return { cookie, created: true };
  }

  const inRes = await api('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: EMAIL, password: PASSWORD },
  });
  if (!inRes.ok) {
    throw new Error(
      `could not sign up or sign in as ${EMAIL}.\n` +
        `sign-up said ${up.status}: ${(await up.text()).slice(0, 200)}\n` +
        `sign-in said ${inRes.status}: ${(await inRes.text()).slice(0, 200)}\n` +
        `Was the Worker started by \`pnpm dev\`, which passes ALLOW_TEST_CREDENTIALS=1?`,
    );
  }
  const cookie = cookieFrom(inRes);
  if (!cookie) throw new Error('sign-in returned no session cookie');
  return { cookie, created: false };
}

async function main() {
  const health = await api('/api/config').catch(() => null);
  if (!health?.ok) {
    throw new Error(`No instance answering at ${BASE}. Start one with \`pnpm dev\`.`);
  }

  const { cookie, created } = await session();
  process.stdout.write(`${created ? 'created' : 'signed in as'} ${EMAIL} on ${BASE}\n`);
  const authed = (path, init = {}) => request(path, { ...init, cookie });

  /*
   * A just-made account is cleared as well as a `--reset` one. Every account is created
   * holding a welcome note (apps/api/src/lib/welcome-note.ts), and the demo account is
   * meant to hold the seed's notes and nothing else — the screenshots are of them, and
   * the trash is the seed's too, which is why this purges rather than trashes. Cleared by
   * the same route as `--reset` rather than looked for by title, so nothing here has to
   * know what the welcome note is called: an account made a moment ago holds nothing else.
   */
  if (created || process.argv.includes('--reset')) {
    const removed = await clearNotes({ request: authed });
    process.stdout.write(
      created ? `cleared the new account's ${removed} starting note(s)\n` : `removed ${removed} existing note(s)\n`,
    );
  }

  const started = Date.now();
  const counts = await loadSeed({
    request: authed,
    small: process.argv.includes('--small'),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    `${counts.created} note(s) created, ${counts.updated} updated, ${counts.files} file(s) uploaded, ` +
      `${counts.trashed} trashed in ${seconds}s — sign in at ${BASE}\n`,
  );
  process.stdout.write(`  email    ${EMAIL}\n  password ${PASSWORD}\n`);
}

await main();

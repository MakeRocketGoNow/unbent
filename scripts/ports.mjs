#!/usr/bin/env node
/**
 * Which ports this checkout's dev servers use.
 *
 * The main checkout keeps 5173/8787, so nothing about the usual setup changes — the
 * Android emulator's `10.0.2.2:5173`, the OAuth redirect URIs registered with Google and
 * GitHub, and every `curl localhost:5173` in the docs all still point at it.
 *
 * A linked worktree gets its own pair, derived from its directory name so that it is the
 * same pair every time without anything being written down or handed out. Both halves
 * move together: the Worker is told the SPA's origin (`--var APP_URL`) and Vite is told
 * the Worker's port, so a worktree's SPA talks to a worktree's Worker and its passkeys,
 * cookies and OAuth callbacks are all on one origin.
 *
 * Used by `scripts/dev.mjs` and, through the CLI below, by `scripts/worktree-setup.sh`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The main checkout's ports: what everything outside this repo already expects. */
const MAIN_WEB_PORT = 5173;
const MAIN_API_PORT = 8787;

/**
 * Worktree ports sit in their own bands, clear of anything already spoken for: 5174 (the
 * port Vite used to drift to) and 8790 (the scratch Worker the API tests use) are both
 * outside them, as is either main port.
 */
const WEB_BASE = 5200;
const API_BASE = 8800;
const SPREAD = 40;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The name of the linked worktree `cwd` sits in, or null for the main checkout.
 *
 * A worktree's git directory is `<main>/.git/worktrees/<name>` while its *common* dir is
 * the main checkout's `.git`; in the main checkout the two are the same path. That
 * distinction is the reliable one — a worktree can live anywhere, so its location says
 * nothing.
 */
export function worktreeName(cwd = process.cwd()) {
  try {
    const gitDir = git(['rev-parse', '--absolute-git-dir'], cwd);
    const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
    if (real(gitDir) === real(commonDir)) return null;
    return basename(real(git(['rev-parse', '--show-toplevel'], cwd)));
  } catch {
    // Not a checkout at all (a tarball, a container image). Treat it as the main one.
    return null;
  }
}

/** FNV-1a. It only has to spread a handful of directory names; nothing here is a hash in the security sense. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function fromEnv(name, env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name}=${raw} is not a port number`);
  }
  return port;
}

/**
 * `{ worktree, web, api }` for a checkout. An explicit `WEB_PORT` / `API_PORT` in the
 * environment wins, so a run can always be pinned by hand — which is how the API tests
 * point themselves at a particular pair.
 */
export function portsFor(cwd = process.cwd(), env = process.env) {
  const worktree = worktreeName(cwd);
  const offset = worktree ? 1 + (fnv1a(worktree) % SPREAD) : null;
  return {
    worktree,
    web: fromEnv('WEB_PORT', env) ?? (offset === null ? MAIN_WEB_PORT : WEB_BASE + offset),
    api: fromEnv('API_PORT', env) ?? (offset === null ? MAIN_API_PORT : API_BASE + offset),
  };
}

/**
 * Point `.claude/launch.json` at this checkout's SPA port.
 *
 * The file is local config rather than a tracked file precisely because its `port` is a
 * literal: a copy carried into a worktree would send the preview tool to the main
 * checkout's server while `pnpm dev` served the branch somewhere else. Writing it here
 * means a worktree's file is right from the first `pnpm dev`, and a stale one heals.
 *
 * Only the `unbent` entry's port is touched; anything else in the file is the user's.
 * Returns what it did, for the caller to report.
 */
export function syncLaunchJson(root, webPort) {
  const path = join(root, '.claude', 'launch.json');
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    config = null;
  }

  if (config === null) {
    config = {
      version: '0.0.1',
      configurations: [
        { name: 'unbent', runtimeExecutable: 'pnpm', runtimeArgs: ['dev'], port: webPort },
      ],
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    return 'created';
  }

  const entry = config.configurations?.find((c) => c.name === 'unbent');
  if (!entry || entry.port === webPort) return 'unchanged';
  entry.port = webPort;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return 'updated';
}

// `eval "$(node scripts/ports.mjs)"` in a shell script; --sync-launch for the setup script.
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const root = git(['rev-parse', '--show-toplevel'], process.cwd());
  const { worktree, web, api } = portsFor(root);
  if (process.argv.includes('--sync-launch')) syncLaunchJson(root, web);
  process.stdout.write(`WEB_PORT=${web}\nAPI_PORT=${api}\nWORKTREE=${worktree ?? ''}\n`);
}

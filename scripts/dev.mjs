#!/usr/bin/env node
/**
 * What `pnpm dev` runs.
 *
 * Both dev servers used to have their ports written into their configs, which meant one
 * checkout at a time: a second Vite drifted to the next free port, whose Host header the
 * proxy forwarded unchanged to a Worker that did not trust it, and the API side could not
 * run twice at all. This picks a pair for the checkout (see `scripts/ports.mjs`), hands it
 * to both halves through the environment, and gets out of the way.
 *
 * `dev:web` / `dev:api` still start one side on its own, with `WEB_PORT` / `API_PORT` set
 * by hand if they need to be something in particular.
 */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { portsFor, syncLaunchJson } from './ports.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { worktree, web, api } = portsFor(root);

const where = worktree ? `${worktree}: ` : '';
process.stdout.write(`${where}web http://localhost:${web}  api http://localhost:${api}\n`);

// Best effort: the preview tool reading a stale port is worth fixing, but not at the cost
// of refusing to start the servers.
try {
  syncLaunchJson(root, web);
} catch (error) {
  process.stderr.write(`could not update .claude/launch.json: ${error.message}\n`);
}

const child = spawn('pnpm', ['--parallel', '--filter', './apps/*', 'dev'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, WEB_PORT: String(web), API_PORT: String(api) },
});

child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

// Exit the way the child did, so Ctrl-C and a crash both read correctly to whatever
// started this.
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { importEnex, type ImportFailure, type ImportProgress } from '@unbent/enex';
import { requestDeviceCode, waitForToken } from './auth.js';
import { ApiError, checkToken, createClient } from './client.js';
import { clearAll, clearToken, readToken, writeToken } from './token-store.js';
import { configPath, normalizeUrl, readUrl, writeUrl } from './config-store.js';
import { createInterface } from 'node:readline/promises';

/**
 * `unbent-migrate` — import an Evernote export from the command line.
 *
 * The browser importer already does this well for a single file, and this is not trying to
 * replace it. It exists for the case the browser is bad at: a whole account's worth of
 * .enex files, run unattended, resumed after an interruption, on a machine where dragging
 * dozens of multi-gigabyte files through a file picker is the worst part of the job.
 */

function usage(): string {
  return `unbent-migrate — import Evernote .enex files into Unbent

Usage:
  unbent-migrate import <file.enex...> [options]
  unbent-migrate login [options]
  unbent-migrate logout [--all]
  unbent-migrate set-url <url>
  unbent-migrate show-config

Options:
  --url <url>       Use this instance for one command, without storing it
  --notebook <name> File the notes under this notebook, overriding the filename
  --no-text         Skip PDF text extraction (faster; scans stay title-only)
  -h, --help        Show this

The instance is asked for once and remembered, so ordinary commands need no --url.
Change it later with \`set-url\`, by editing the config file \`show-config\` prints,
or per-command with \`--url\`. $UNBENT_URL overrides the stored value.

Re-running the same file is safe: notes that already landed are skipped.
`;
}

interface Args {
  command: string;
  files: string[];
  /** Only set by --url or $UNBENT_URL; otherwise resolved from config, or asked for. */
  url?: string;
  notebook?: string;
  extractText: boolean;
  all: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: '',
    files: [],
    url: process.env['UNBENT_URL'],
    extractText: true,
    all: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') args.url = argv[++i] ?? args.url;
    else if (arg === '--notebook') args.notebook = argv[++i];
    else if (arg === '--no-text') args.extractText = false;
    else if (arg === '--all') args.all = true;
    else if (arg === '-h' || arg === '--help') args.command = 'help';
    else if (!arg?.startsWith('-')) {
      if (!args.command) args.command = arg ?? '';
      else args.files.push(arg ?? '');
    }
  }

  return args;
}

/** Progress on one rewritten line, so a long import does not scroll the terminal away. */
function renderProgress(p: ImportProgress, elapsedMs: number): void {
  if (!process.stdout.isTTY) return;
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  const line =
    `  ${p.created} imported · ${p.skipped} skipped · ${p.filesUploaded} files` +
    `${p.failed ? ` · ${p.failed} failed` : ''} · ${formatBytes(p.bytesRead)} · ${secs}s`;
  process.stdout.write(`\r\x1b[2K${line.slice(0, (process.stdout.columns ?? 80) - 1)}`);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Which instance to talk to.
 *
 * Order: an explicit --url or $UNBENT_URL, then whatever this machine was pointed at
 * before, then ask. There is deliberately no fallback — a guessed instance would let a
 * mistyped or forgotten flag send someone's notes to a server they did not choose, and
 * that failure is silent, because uploading to the wrong Unbent still succeeds.
 */
async function resolveUrl(args: Args): Promise<string> {
  if (args.url) return normalizeUrl(args.url);

  const stored = await readUrl();
  if (stored) return stored;

  if (!process.stdin.isTTY) {
    throw new Error(
      'No Unbent instance configured. Run `unbent-migrate set-url <url>`, ' +
        'or pass --url.',
    );
  }

  process.stdout.write(
    '\nWhich Unbent instance? (for example https://notes.example.com)\n',
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('  URL: ');
    const url = await writeUrl(answer);
    process.stdout.write(`  Saved to ${configPath()}\n\n`);
    return url;
  } finally {
    rl.close();
  }
}

/**
 * Signs in, reusing a stored token when there is one and it still works.
 *
 * The check is one request, and it is worth it: importEnex records per-note errors as
 * failures rather than throwing, so an expired token would otherwise appear as every note
 * failing with the same 401 and a closing suggestion to re-run — advice that cannot work
 * until the user signs in again. Catching it here turns that into a sign-in prompt before
 * any note is touched.
 */
async function ensureToken(url: string): Promise<string> {
  const existing = await readToken(url);
  if (existing && (await checkToken(url, existing))) return existing;
  if (existing) process.stdout.write('  Session expired.\n');
  return login(url);
}

async function login(url: string): Promise<string> {
  const grant = await requestDeviceCode(url);
  const target = grant.verification_uri_complete ?? grant.verification_uri;

  process.stdout.write(
    `\n  Open:  ${target}\n` +
      `  Code:  ${grant.user_code}\n\n` +
      `  Waiting for approval…`,
  );

  const token = await waitForToken(url, grant);
  await writeToken(url, token);
  process.stdout.write('\r\x1b[2K  Signed in.\n');
  return token;
}

async function runImport(args: Args): Promise<number> {
  if (args.files.length === 0) {
    process.stderr.write('Nothing to import: pass one or more .enex files.\n');
    return 1;
  }

  const url = await resolveUrl(args);
  const token = await ensureToken(url);
  const client = createClient(url, token);
  const failures: ImportFailure[] = [];
  let exitCode = 0;

  for (const path of args.files) {
    const full = resolve(path);
    const name = basename(full);
    process.stdout.write(`\n${name}\n`);

    const started = Date.now();
    let handle;
    try {
      handle = await open(full, 'r');
    } catch {
      process.stderr.write(`  Could not read ${full}\n`);
      exitCode = 1;
      continue;
    }

    try {
      const before = failures.length;
      const progress = await importEnex(
        {
          name,
          // Node's file stream, adapted to the web stream importEnex expects. Streaming
          // rather than reading the file in: these are routinely larger than memory.
          stream: () =>
            Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>,
        },
        client,
        {
          notebookTag: args.notebook,
          extractText: args.extractText,
          onProgress: (p) => renderProgress(p, Date.now() - started),
          onFailure: (f) => failures.push(f),
        },
      );

      const failed = failures.length - before;
      process.stdout.write(
        `\r\x1b[2K  ${progress.created} imported, ${progress.skipped} already present, ` +
          `${progress.filesUploaded} files${failed ? `, ${failed} failed` : ''}.\n`,
      );
      if (failed) exitCode = 1;
    } catch (err) {
      process.stdout.write('\r\x1b[2K');
      if (err instanceof ApiError && err.status === 401) {
        process.stderr.write('  Session expired. Run `unbent-migrate login` and try again.\n');
        return 1;
      }
      process.stderr.write(`  ${err instanceof Error ? err.message : String(err)}\n`);
      exitCode = 1;
    } finally {
      await handle.close();
    }
  }

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} note(s) failed:\n`);
    // Capped because a bad export can fail thousands of notes, and a screenful is enough
    // to see the pattern. Re-running retries only these.
    for (const f of failures.slice(0, 20)) {
      process.stdout.write(`  ${f.title} — ${f.reason}\n`);
    }
    if (failures.length > 20) {
      process.stdout.write(`  …and ${failures.length - 20} more\n`);
    }
    process.stdout.write('\nRe-run the same files to retry just these.\n');
  }

  return exitCode;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'import':
      return runImport(args);
    case 'login':
      await login(await resolveUrl(args));
      return 0;
    case 'logout':
      if (args.all) {
        await clearAll();
      } else {
        // Reads the stored URL rather than asking: signing out of an instance you have
        // not configured is a no-op, and prompting for one would be theatre.
        const url = args.url ?? (await readUrl());
        if (url) await clearToken(url);
      }
      process.stdout.write('Signed out locally. Revoke the session in Unbent to be certain.\n');
      return 0;
    case 'set-url': {
      const value = args.files[0];
      if (!value) {
        process.stderr.write('Usage: unbent-migrate set-url <url>\n');
        return 1;
      }
      const url = await writeUrl(value);
      process.stdout.write(`Instance set to ${url}\n${configPath()}\n`);
      return 0;
    }
    case 'show-config': {
      const url = await readUrl();
      process.stdout.write(`${configPath()}\n`);
      process.stdout.write(url ? `  url: ${url}\n` : '  (no instance set yet)\n');
      return 0;
    }
    case 'help':
    case '':
      process.stdout.write(usage());
      return 0;
    default:
      process.stderr.write(`Unknown command: ${args.command}\n\n${usage()}`);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

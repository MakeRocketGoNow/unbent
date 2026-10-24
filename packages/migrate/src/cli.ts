#!/usr/bin/env node
import { openAsBlob } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  importArchive,
  importEnex,
  importJoplin,
  importFormat,
  type ImportFailure,
  type ImportOptions,
  type ImportProgress,
  type ImportSkip,
} from '@unbent/enex';
import { requestDeviceCode, waitForToken } from './auth.js';
import { ApiError, checkToken, createClient } from './client.js';
import { clearAll, clearToken, readToken, writeToken } from './token-store.js';
import { configPath, normalizeUrl, readUrl, writeUrl } from './config-store.js';
import { createInterface } from 'node:readline/promises';

/**
 * `unbent-migrate`: import an Evernote export, or an Unbent one, from the command line.
 *
 * The browser importer already does this well for a single file, and this is not trying to
 * replace it. It exists for the case the browser is bad at: a whole account's worth of
 * .enex files, run unattended, resumed after an interruption, on a machine where dragging
 * dozens of multi-gigabyte files through a file picker is the worst part of the job. An
 * Unbent export is taken for the same reason: a backup restored from a shell, or a
 * library moved between instances without a browser in the loop.
 */

function usage(): string {
  return `unbent-migrate: import Evernote .enex files, Joplin .jex files, or Unbent exports, into Unbent

Usage:
  unbent-migrate import <file...> [options]
  unbent-migrate login [options]
  unbent-migrate logout [--all]
  unbent-migrate set-url <url>
  unbent-migrate show-config

Files are .enex (Evernote), .jex (Joplin), or .zip and .md (an Unbent export:
the library, a notebook, or one note). An .enex file's name becomes its notes'
notebook; a Joplin or Unbent export's notes each carry their own.

Options:
  --url <url>       Use this instance for one command, without storing it
  --notebook <name> File every note under this notebook instead
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
 * before, then ask. There is deliberately no fallback: a guessed instance would let a
 * mistyped or forgotten flag send someone's notes to a server they did not choose, and
 * that failure is silent, because uploading to the wrong Unbent still succeeds.
 */
async function resolveUrl(args: Args): Promise<string> {
  if (args.url) return normalizeUrl(args.url);

  const stored = await readUrl();
  if (stored) return stored;

  if (!process.stdin.isTTY) {
    throw new Error(
      'No Unbent instance configured. Run `unbent-migrate set-url https://unbent.app`, ' +
        'or pass --url.',
    );
  }

  process.stdout.write(
    '\nWhich Unbent instance? (for example https://unbent.app)\n',
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
 * failing with the same 401 and a closing suggestion to re-run: advice that cannot work
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
    process.stderr.write('Nothing to import: pass one or more .enex, .jex, .zip or .md files.\n');
    return 1;
  }

  const url = await resolveUrl(args);
  const token = await ensureToken(url);
  const client = createClient(url, token);
  const failures: ImportFailure[] = [];
  // Copies inside a file, kept apart from notes that were here before the run: a count of
  // "already present" cannot explain skips into a notebook that was empty when it started.
  const duplicates: Array<ImportSkip & { file: string }> = [];
  let exitCode = 0;

  for (const path of args.files) {
    const full = resolve(path);
    const name = basename(full);
    process.stdout.write(`\n${name}\n`);

    const format = importFormat(name);
    if (format === null) {
      process.stderr.write('  Skipped: not an .enex, .jex, .zip or .md file.\n');
      exitCode = 1;
      continue;
    }

    const started = Date.now();
    const options: ImportOptions = {
      notebookTag: args.notebook,
      extractText: args.extractText,
      onProgress: (p) => renderProgress(p, Date.now() - started),
      onFailure: (f) => failures.push(f),
      onSkip: (s) => {
        if (s.earlierInFile) duplicates.push({ ...s, file: name });
      },
    };

    let handle: FileHandle | undefined;
    try {
      const before = failures.length;
      const duplicatesBefore = duplicates.length;
      let progress: ImportProgress;
      if (format === 'enex') {
        handle = await open(full, 'r');
        const stream = handle;
        progress = await importEnex(
          {
            name,
            // Node's file stream, adapted to the web stream importEnex expects. Streaming
            // rather than reading the file in: these are routinely larger than memory.
            stream: () =>
              Readable.toWeb(stream.createReadStream()) as ReadableStream<Uint8Array>,
          },
          client,
          options,
        );
      } else if (format === 'jex') {
        // A tar, read by byte range from the same lazily read Blob as a zip below.
        progress = await importJoplin({ name, blob: await openAsBlob(full) }, client, options);
      } else {
        // A lazily read Blob, not the file's bytes: zip.js reads the central directory
        // and then each entry by byte range, so an archive is never held in memory whole.
        progress = await importArchive({ name, blob: await openAsBlob(full) }, client, options);
      }

      const failed = failures.length - before;
      const duplicated = duplicates.length - duplicatesBefore;
      process.stdout.write(
        `\r\x1b[2K  ${progress.created} imported, ` +
          (duplicated ? `${duplicated} duplicate${duplicated === 1 ? '' : 's'} skipped, ` : '') +
          `${progress.skipped - duplicated} already present, ` +
          `${progress.filesUploaded} files${failed ? `, ${failed} failed` : ''}.\n`,
      );
      if (failed) exitCode = 1;
    } catch (err) {
      process.stdout.write('\r\x1b[2K');
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        process.stderr.write(`  Could not read ${full}\n`);
        exitCode = 1;
        continue;
      }
      if (err instanceof ApiError && err.status === 401) {
        process.stderr.write('  Session expired. Run `unbent-migrate login` and try again.\n');
        return 1;
      }
      process.stderr.write(`  ${err instanceof Error ? err.message : String(err)}\n`);
      exitCode = 1;
    } finally {
      await handle?.close();
    }
  }

  if (duplicates.length > 0) {
    process.stdout.write(
      `\n${duplicates.length} note(s) were identical to an earlier note in the same file (` +
        `title, text, tags, dates and attachments), so only that earlier note was imported:\n`,
    );
    for (const d of duplicates.slice(0, 20)) {
      process.stdout.write(`  ${d.title}: ${d.file}, kept as ${d.noteId}\n`);
    }
    if (duplicates.length > 20) {
      process.stdout.write(`  …and ${duplicates.length - 20} more\n`);
    }
  }

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} note(s) failed:\n`);
    // Capped because a bad export can fail thousands of notes, and a screenful is enough
    // to see the pattern. Re-running retries only these.
    for (const f of failures.slice(0, 20)) {
      process.stdout.write(`  ${f.title}: ${f.reason}\n`);
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

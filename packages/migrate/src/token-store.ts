import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the CLI keeps its session between runs.
 *
 * A migration is resumed more often than it is finished in one go, so signing in every
 * time would be its own friction. The file holds a real session token: it is written
 * 0600, in a 0700 directory, and keyed by server URL so a token for one instance is never
 * sent to another.
 *
 * Not the system keychain, which would mean a native dependency and a different story per
 * platform for what is already a scoped, revocable, thirty-day token, revoked from the
 * app by signing out everywhere.
 */

interface TokenFile {
  /** Base URL → token. Keyed so a local instance and a deployed one can coexist. */
  tokens: Record<string, string>;
}

function configPath(): string {
  // XDG when set, so anyone who has moved their config directory is honoured.
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(base, 'unbent', 'credentials.json');
}

/** Normalized so http://host and http://host/ do not become two entries. */
function key(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

export async function readToken(baseUrl: string): Promise<string | undefined> {
  try {
    const raw = await readFile(configPath(), 'utf8');
    return (JSON.parse(raw) as TokenFile).tokens?.[key(baseUrl)];
  } catch {
    // Absent or unreadable is not an error: it means "sign in", which is the caller's
    // next move anyway. A corrupt file is treated the same rather than blocking the CLI.
    return undefined;
  }
}

export async function writeToken(baseUrl: string, token: string): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  let existing: TokenFile = { tokens: {} };
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as TokenFile;
  } catch {
    // Keep the fresh object; a corrupt file is replaced rather than merged into.
  }

  existing.tokens = { ...existing.tokens, [key(baseUrl)]: token };
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  // Explicit chmod as well as the mode above: writeFile's mode only applies when it
  // creates the file, so an existing file keeps whatever permissions it already had.
  await chmod(path, 0o600);
}

/** Forgets one instance's token. The session itself is revoked from the app. */
export async function clearToken(baseUrl: string): Promise<void> {
  const path = configPath();
  try {
    const existing = JSON.parse(await readFile(path, 'utf8')) as TokenFile;
    delete existing.tokens?.[key(baseUrl)];
    await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  } catch {
    // Nothing stored is already the desired state.
  }
}

/** Removes the whole credentials file. Used by `logout --all`. */
export async function clearAll(): Promise<void> {
  await rm(configPath(), { force: true });
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Which Unbent instance this machine talks to.
 *
 * Deliberately a separate file from `credentials.json` rather than another field in it.
 * The credentials file is 0600 and holds a live session token; this one is meant to be
 * opened and edited by hand, and telling someone to hand-edit a secrets file to change a
 * URL is how secrets end up pasted into issues and screenshots.
 *
 * There is no default instance. A tool that guesses is a tool that can silently send a
 * migration to the wrong server: either a developer's localhost, or, worse, whatever
 * instance the project author happens to run. Asking once and remembering costs the user
 * one prompt and removes that failure entirely.
 */

interface ConfigFile {
  /** Base URL of the instance, origin only. */
  url?: string;
}

export function configPath(): string {
  // XDG when set, so anyone who has moved their config directory is honoured.
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(base, 'unbent', 'config.json');
}

/**
 * Normalizes to an origin, and rejects anything that is not a real http(s) URL.
 *
 * A bare host is accepted and assumed https: someone typing `unbent.app` means the
 * site, and failing them over a missing scheme would be pedantry. Anything else throws,
 * because a URL that parses into something unexpected is worse than one that does not
 * parse at all: it fails later, against the wrong server.
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('No URL given.');

  /**
   * A scheme that is present but not http(s) is rejected here, before anything is
   * prepended. Testing only for `http(s)://` and prefixing everything else turns
   * `file:///etc/passwd` into `https://file:///etc/passwd`, which parses cleanly as the
   * host `file`: a real, fetchable origin nobody typed. Failing to parse would have been
   * safe; parsing into something else is not.
   */
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    throw new Error(`Not an http(s) URL: ${input}`);
  }

  // `(?!\d)` above keeps `localhost:5173` a host and port rather than a scheme called
  // "localhost": a bare host:port is the most likely thing anyone types for a local
  // instance, and rejecting it would be worse than the problem being guarded against.
  const withScheme = scheme ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid URL: ${input}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Not an http(s) URL: ${input}`);
  }
  return parsed.origin;
}

/** The stored instance URL, or undefined when this machine has not been pointed at one. */
export async function readUrl(): Promise<string | undefined> {
  try {
    const raw = await readFile(configPath(), 'utf8');
    const url = (JSON.parse(raw) as ConfigFile).url;
    return url ? normalizeUrl(url) : undefined;
  } catch {
    // Missing or unreadable means "not configured yet", which the caller handles by
    // asking. A corrupt file is treated the same rather than blocking the CLI.
    return undefined;
  }
}

/** Points this machine at an instance. 0644, because it is meant to be edited. */
export async function writeUrl(url: string): Promise<string> {
  const normalized = normalizeUrl(url);
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const body: ConfigFile = { url: normalized };
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o644 });
  return normalized;
}

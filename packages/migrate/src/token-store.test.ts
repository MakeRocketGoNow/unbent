import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearAll, clearToken, readToken, writeToken } from './token-store.js';

/**
 * The store holds a real session token, so the tests that matter are about where it lands
 * and who can read it, not just whether it round-trips.
 */
describe('token store', () => {
  let dir: string;
  const original = process.env['XDG_CONFIG_HOME'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'unbent-token-'));
    process.env['XDG_CONFIG_HOME'] = dir;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = original;
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a token', async () => {
    await writeToken('https://notes.example', 'tok_abc');
    expect(await readToken('https://notes.example')).toBe('tok_abc');
  });

  it('returns undefined when nothing is stored', async () => {
    expect(await readToken('https://notes.example')).toBeUndefined();
  });

  it('writes the file 0600', async () => {
    await writeToken('https://notes.example', 'tok_abc');
    const info = await stat(join(dir, 'unbent', 'credentials.json'));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('tightens permissions on a file that already exists', async () => {
    // writeFile's mode only applies on create, so a file left world-readable by an older
    // version — or by a user's own editor — would otherwise keep those permissions.
    const path = join(dir, 'unbent', 'credentials.json');
    await mkdir(join(dir, 'unbent'), { recursive: true });
    await writeFile(path, '{"tokens":{}}', { mode: 0o644 });

    await writeToken('https://notes.example', 'tok_abc');

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('keeps instances apart, so one server never gets a token meant for another', async () => {
    await writeToken('https://a.example', 'tok_a');
    await writeToken('https://b.example', 'tok_b');

    expect(await readToken('https://a.example')).toBe('tok_a');
    expect(await readToken('https://b.example')).toBe('tok_b');
  });

  it('treats a trailing slash and a path as the same instance', async () => {
    await writeToken('https://notes.example', 'tok_abc');
    expect(await readToken('https://notes.example/')).toBe('tok_abc');
  });

  it('survives a corrupt file rather than blocking the CLI', async () => {
    await mkdir(join(dir, 'unbent'), { recursive: true });
    await writeFile(join(dir, 'unbent', 'credentials.json'), 'not json at all');

    expect(await readToken('https://notes.example')).toBeUndefined();
    // And a write still succeeds, replacing the unreadable file.
    await writeToken('https://notes.example', 'tok_abc');
    expect(await readToken('https://notes.example')).toBe('tok_abc');
  });

  it('clears one instance without touching the others', async () => {
    await writeToken('https://a.example', 'tok_a');
    await writeToken('https://b.example', 'tok_b');

    await clearToken('https://a.example');

    expect(await readToken('https://a.example')).toBeUndefined();
    expect(await readToken('https://b.example')).toBe('tok_b');
  });

  it('clears everything on logout --all', async () => {
    await writeToken('https://a.example', 'tok_a');
    await writeToken('https://b.example', 'tok_b');

    await clearAll();

    expect(await readToken('https://a.example')).toBeUndefined();
    expect(await readToken('https://b.example')).toBeUndefined();
  });

  it('does not write the token into the file as plain text under a guessable key', async () => {
    // Not encryption — the file is 0600 and that is the protection. This only asserts the
    // shape stays keyed by origin, since a flat "token" field would be trivially harvested
    // by anything scanning dotfiles for secrets.
    await writeToken('https://notes.example', 'tok_abc');
    const raw = JSON.parse(
      await readFile(join(dir, 'unbent', 'credentials.json'), 'utf8'),
    ) as { tokens: Record<string, string> };
    expect(Object.keys(raw.tokens)).toEqual(['https://notes.example']);
  });
});

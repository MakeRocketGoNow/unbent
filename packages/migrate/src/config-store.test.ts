import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, normalizeUrl, readUrl, writeUrl } from './config-store.js';

describe('normalizeUrl', () => {
  it('keeps a full https URL, reduced to its origin', () => {
    expect(normalizeUrl('https://notes.example.com')).toBe('https://notes.example.com');
    expect(normalizeUrl('https://notes.example.com/notes?tag=x')).toBe(
      'https://notes.example.com',
    );
  });

  it('assumes https for a bare host, rather than failing over a missing scheme', () => {
    expect(normalizeUrl('notes.example.com')).toBe('https://notes.example.com');
  });

  it('keeps http and its port, so a local instance still works', () => {
    expect(normalizeUrl('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('reads a bare host:port as a host, not as a scheme', () => {
    // `localhost:5173` is the likeliest thing anyone types for a local instance, and a
    // naive scheme check treats "localhost" as one and rejects it.
    expect(normalizeUrl('localhost:5173')).toBe('https://localhost:5173');
    expect(normalizeUrl('127.0.0.1:8787')).toBe('https://127.0.0.1:8787');
  });

  it('ignores surrounding whitespace, which a paste often carries', () => {
    expect(normalizeUrl('  https://notes.example.com  ')).toBe('https://notes.example.com');
  });

  it('drops a trailing slash, so one instance is not stored twice', () => {
    expect(normalizeUrl('https://notes.example.com/')).toBe('https://notes.example.com');
  });

  it('refuses a non-http scheme rather than accepting something unusable', () => {
    // file: and javascript: parse fine as URLs, which is exactly why this has to be
    // checked — a value that parses but cannot be fetched fails later and less clearly.
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(/http/i);
    expect(() => normalizeUrl('ftp://example.com')).toThrow(/http/i);
  });

  it('refuses an empty value', () => {
    expect(() => normalizeUrl('   ')).toThrow();
  });
});

describe('config store', () => {
  let dir: string;
  const original = process.env['XDG_CONFIG_HOME'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'unbent-config-'));
    process.env['XDG_CONFIG_HOME'] = dir;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = original;
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips the instance URL', async () => {
    await writeUrl('https://notes.example.com');
    expect(await readUrl()).toBe('https://notes.example.com');
  });

  it('reports nothing when this machine has not been pointed at an instance', async () => {
    expect(await readUrl()).toBeUndefined();
  });

  it('normalizes on the way in, so the file never holds a path or a stray slash', async () => {
    await writeUrl('notes.example.com/notes/');
    expect(await readUrl()).toBe('https://notes.example.com');
  });

  it('writes a file the user can actually open and edit', async () => {
    // 0644, unlike credentials.json — this is meant to be edited by hand, and telling
    // someone to edit a 0600 secrets file to change a URL invites pasting a token
    // somewhere public.
    await writeUrl('https://notes.example.com');
    const info = await stat(configPath());
    expect(info.mode & 0o777).toBe(0o644);
  });

  it('survives a corrupt file rather than blocking every command', async () => {
    await mkdir(join(dir, 'unbent'), { recursive: true });
    await writeFile(configPath(), 'not json');

    expect(await readUrl()).toBeUndefined();
    await writeUrl('https://notes.example.com');
    expect(await readUrl()).toBe('https://notes.example.com');
  });

  it('is a different file from the credentials, so a token is never near it', async () => {
    await writeUrl('https://notes.example.com');
    expect(configPath().endsWith('config.json')).toBe(true);
  });
});

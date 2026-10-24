import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHELL_META_CACHE, WORKER_PAGES, WORKER_PREFIXES, classify, commitOf, coverOf, fileAddress, isAsset, isShellFallback, servesShell, shellCacheName, shelved, staleShellCaches, within, type RequestFacts } from './routes.js';

const at = (path: string) => new URL(path, 'https://unbent.example');

describe('servesShell', () => {
  it.each([
    '/',
    '/notes',
    '/notes/8f0c2d1e-5a4b-4c3d-9e8f-7a6b5c4d3e2f',
    '/settings/tags',
    '/trash',
    '/login',
    '/privacy',
    '/notes?notebook=Coupons&tag=a&tag=b',
    // The Worker's static copy of the page online; the shell draws the same page offline.
    '/why',
  ])('gives %s the app', (path) => {
    expect(servesShell(at(path))).toBe(true);
  });

  it.each([
    // The Worker's own answers: a sign-in callback, a download, discovery, analytics.
    '/api/auth/callback/google?code=x',
    '/api/notes/8f0c/files/Report (final) v2.pdf?download=1',
    '/api/notes',
    '/.well-known/oauth-authorization-server',
    '/ingest/e/',
    // Real files, opened directly.
    '/manifest.webmanifest',
    '/icons/icon-192.png',
    '/sw.js',
    '/pdfjs/wasm/openjpeg.wasm',
  ])('leaves %s to the network', (path) => {
    expect(servesShell(at(path))).toBe(false);
  });
});

const ORIGIN = 'https://unbent.example';
const facts = (path: string, over: Partial<RequestFacts> = {}): RequestFacts => ({
  url: new URL(path, ORIGIN),
  method: 'GET',
  destination: '',
  viewed: false,
  origin: ORIGIN,
  ...over,
});

describe('classify', () => {
  it('keeps the last copy of the instance\'s config, and of nothing else the views read', () => {
    expect(classify(facts('/api/config'))).toBe('api');
  });

  it.each([
    // What the views are drawn from comes from the local copy of the library, not a cache.
    '/api/notes',
    '/api/notes?notebook=Coupons&tag=a&sort=title&cursor=abc',
    '/api/notes?trashed=1&limit=1',
    '/api/notes/8f0c2d1e',
    '/api/notes/8f0c2d1e/files',
    '/api/tags',
    '/api/notebooks',
    '/api/notebooks/nb1/fields',
    '/api/notebooks/nb1/fields?counts=1',
    // Not a read the views are drawn from.
    '/api/notes/8f0c2d1e/export',
    '/api/notebooks/nb1/fields/f1/conversion?to=number',
    '/api/notebooks/nb1/fields/f1/option-usage?option=a',
    '/api/notes/8f0c2d1e/files/Report%20(final)%20v2.pdf/text',
    // Nothing offline could use.
    '/api/search?q=invoice',
    '/api/export/notes',
    '/api/health',
    '/api/auth/get-session',
    '/api/admin/store/stats',
    // The change feed is never answered from a cache: a cached page would replay stale
    // rows over a client's cursor, and a snapshot is the one read that must be current.
    '/api/changes?since=120&limit=200',
    '/api/changes/snapshot?cursor=8f0c2d1e&limit=200',
  ])('passes %s straight through', (path) => {
    expect(classify(facts(path))).toBeUndefined();
  });

  it('never caches a write', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(classify(facts('/api/notes/8f0c2d1e', { method }))).toBeUndefined();
    }
  });

  const file = '/api/notes/8f0c2d1e/files/Report%20(final)%20v2.pdf';

  it('keeps a file someone is looking at', () => {
    expect(classify(facts('/api/notes/8f0c2d1e/files/receipt.png', { destination: 'image' }))).toBe('file');
    expect(classify(facts(file, { viewed: true }))).toBe('file');
  });

  it('leaves the indexer’s and the export’s reads of the same file alone', () => {
    expect(classify(facts(file))).toBeUndefined();
  });

  /* A gallery scrolled past is not a file opened: keeping covers would push out what was. */
  it('does not keep a card’s cover, though it is drawn as an image', () => {
    expect(classify(facts('/api/notes/8f0c2d1e/files/receipt.png?cover=1', { destination: 'image' }))).toBeUndefined();
  });

  it('reads a cover from the address the opened file is kept under', () => {
    const at = (path: string, method = 'GET') => ({ url: new URL(path, ORIGIN), method, origin: ORIGIN });
    expect(coverOf(at('/api/notes/8f0c2d1e/files/Report%20(final)%20v2.png?cover=1'))).toBe(
      `${ORIGIN}/api/notes/8f0c2d1e/files/Report%20(final)%20v2.png`,
    );
    expect(coverOf(at('/api/notes/8f0c2d1e/files/receipt.png'))).toBeNull();
    expect(coverOf(at('/api/notes/8f0c2d1e/files/receipt.png/text?cover=1'))).toBeNull();
    expect(coverOf(at('/api/notes/8f0c2d1e/files/receipt.png?cover=1', 'POST'))).toBeNull();
    expect(coverOf({ url: new URL('https://images.example/api/notes/a/files/b.png?cover=1'), method: 'GET', origin: ORIGIN })).toBeNull();
  });

  it('leaves a download alone', () => {
    expect(classify(facts(`${file}?download=1`, { viewed: true }))).toBeUndefined();
  });

  it('leaves another site’s image alone', () => {
    expect(
      classify(facts('https://images.example/receipt.png', { destination: 'image' })),
    ).toBeUndefined();
  });

  /**
   * Turnstile's script and challenge, which the sign-in screen loads from Cloudflare where
   * the instance asks for a token (MAK-243). Never kept: a challenge answered from a cache
   * is not a challenge, and the shell loads without it, as the sign-in screen's own sentence
   * for a widget that could not run assumes.
   */
  it('never keeps Turnstile’s script or its challenge', () => {
    const script = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    const frame = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc/1x00/auto/fbE/new/normal/auto/';
    expect(classify(facts(script, { destination: 'script' }))).toBeUndefined();
    expect(classify(facts(frame, { destination: 'iframe' }))).toBeUndefined();
    expect(isAsset(new URL(script), ORIGIN)).toBe(false);
  });
});

/*
 * The Worker answers some paths itself, ahead of its SPA fallback (`run_worker_first` in
 * `apps/api/wrangler.toml`, once per environment). The service worker must leave page
 * loads of exactly those alone, or it would answer an OAuth callback with the app on every
 * device that has it, until another deploy.
 */
describe('WORKER_PREFIXES', () => {
  it('is the Worker’s own run_worker_first, in every environment, less the pages it hands over whole', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const toml = readFileSync(resolve(here, '../../../api/wrangler.toml'), 'utf8');
    const blocks = [...toml.matchAll(/^\s*run_worker_first\s*=\s*\[([\s\S]*?)\]/gm)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, body] of blocks) {
      const entries = [...body!.matchAll(/^\s*"([^"]+)"/gm)].map(([, path]) => path!.replace(/\*$/, ''));
      expect(new Set(entries)).toEqual(new Set([...WORKER_PREFIXES, ...WORKER_PAGES]));
    }
  });
});

describe('shelved', () => {
  const ask = (path: string, over: Partial<{ method: string; mode: string; origin: string }> = {}) =>
    shelved({ url: at(path), method: 'GET', mode: 'cors', origin: ORIGIN, ...over });

  it('names the note and the file for any read of a file’s bytes by the page', () => {
    expect(ask('/api/notes/8f0c/files/Report%20(final)%20v2.pdf')).toEqual({ noteId: '8f0c', filename: 'Report (final) v2.pdf' });
    // An export or the indexer reads the same address unmarked; the shelf answers those too.
    expect(ask('/api/notes/8f0c/files/scan.pdf?download=1')).toEqual({ noteId: '8f0c', filename: 'scan.pdf' });
    expect(ask('/api/notes/8f0c/files/photo.jpg', { mode: 'no-cors' })).toEqual({ noteId: '8f0c', filename: 'photo.jpg' });
  });

  it('never answers a page load, a write, another origin, or anything that is not the bytes', () => {
    expect(ask('/api/notes/8f0c/files/page.html', { mode: 'navigate' })).toBeNull();
    expect(ask('/api/notes/8f0c/files/scan.pdf', { method: 'DELETE' })).toBeNull();
    expect(ask('/api/notes/8f0c/files/scan.pdf', { origin: 'https://elsewhere.example' })).toBeNull();
    expect(ask('/api/notes/8f0c/files/scan.pdf/text')).toBeNull();
    expect(ask('/api/notes/8f0c/files')).toBeNull();
    expect(ask('/api/notes/8f0c')).toBeNull();
  });

  it('declines an address that does not decode', () => {
    expect(fileAddress(at('/api/notes/8f0c/files/%E0%A4%A'))).toBeNull();
  });
});

describe('isShellFallback', () => {
  const html = 'text/html; charset=utf-8';

  it('names an HTML answer for a script, a stylesheet or a wasm file as the page in disguise', () => {
    expect(isShellFallback(new URL('https://unbent.app/assets/notes-abc123.js'), html)).toBe(true);
    expect(isShellFallback(new URL('https://unbent.app/assets/index-abc123.css'), html)).toBe(true);
    expect(isShellFallback(new URL('https://unbent.app/assets/pdf.wasm'), html)).toBe(true);
  });

  it('lets the page itself, and a file answered as itself, through', () => {
    expect(isShellFallback(new URL('https://unbent.app/index.html'), html)).toBe(false);
    expect(isShellFallback(new URL('https://unbent.app/assets/notes-abc123.js'), 'text/javascript; charset=utf-8')).toBe(false);
    expect(isShellFallback(new URL('https://unbent.app/assets/notes-abc123.js'), null)).toBe(false);
    expect(isShellFallback(new URL('https://unbent.app/notes'), html)).toBe(false);
  });
});

describe('isAsset', () => {
  it('is a hashed file of this origin under /assets/', () => {
    expect(isAsset(new URL('https://unbent.app/assets/notes-abc123.js'), 'https://unbent.app')).toBe(true);
    expect(isAsset(new URL('https://unbent.app/icons/icon-192.png'), 'https://unbent.app')).toBe(false);
    expect(isAsset(new URL('https://cdn.example.com/assets/x.js'), 'https://unbent.app')).toBe(false);
  });
});

describe('staleShellCaches', () => {
  const current = shellCacheName('c');
  const previous = shellCacheName('b');
  const older = shellCacheName('a');
  const oldest = shellCacheName('0');

  it('keeps this build, the previous one and every build an open page runs', () => {
    const names = [current, previous, older, oldest];
    expect(staleShellCaches(names, { current, previous, running: new Set([older]) })).toEqual([oldest]);
  });

  /* A tab that outlives several deploys keeps its chunks for as long as it is open. */
  it('keeps a build any number of deploys back while a page runs it', () => {
    expect(staleShellCaches([current, oldest], { current, running: new Set([oldest]) })).toEqual([]);
  });

  it('deletes Workbox’s one cache and leaves the meta and runtime caches alone', () => {
    const names = [current, SHELL_META_CACHE, 'api-v1', 'files-v1', 'workbox-precache-v2-https://unbent.app/'];
    expect(staleShellCaches(names, { current, running: new Set() })).toEqual(['workbox-precache-v2-https://unbent.app/']);
  });
});

describe('commitOf', () => {
  it('reads the commit a build’s page names', () => {
    expect(commitOf('<head><meta name="unbent-commit" content="abc1234" /></head>')).toBe('abc1234');
    expect(commitOf('<head></head>')).toBeNull();
  });
});

describe('within', () => {
  afterEach(() => vi.useRealTimers());

  it('gives the value when it arrives in time', async () => {
    vi.useFakeTimers();
    const result = within(Promise.resolve('file'), 1500, null);
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe('file');
  });

  it('gives the fallback when it does not', async () => {
    vi.useFakeTimers();
    const result = within(new Promise<string>(() => {}), 1500, null);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toBeNull();
  });

  it('gives the fallback when the promise rejects', async () => {
    vi.useFakeTimers();
    const result = within(Promise.reject(new Error('locked')), 1500, null);
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBeNull();
  });
});

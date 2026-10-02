import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORKER_PREFIXES, classify, servesShell, type RequestFacts } from './routes.js';

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
    '/api/attachments/pending-vision',
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

  it('leaves a download alone', () => {
    expect(classify(facts(`${file}?download=1`, { viewed: true }))).toBeUndefined();
  });

  it('leaves another site’s image alone', () => {
    expect(
      classify(facts('https://images.example/receipt.png', { destination: 'image' })),
    ).toBeUndefined();
  });
});

/*
 * The Worker answers some paths itself, ahead of its SPA fallback (`run_worker_first` in
 * `apps/api/wrangler.toml`, once per environment). The service worker must leave page
 * loads of exactly those alone, or it would answer an OAuth callback with the app on every
 * device that has it — until another deploy.
 */
describe('WORKER_PREFIXES', () => {
  it('is the Worker’s own run_worker_first, in every environment', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const toml = readFileSync(resolve(here, '../../../api/wrangler.toml'), 'utf8');
    const blocks = [...toml.matchAll(/^\s*run_worker_first\s*=\s*\[([\s\S]*?)\]/gm)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, body] of blocks) {
      const entries = [...body!.matchAll(/^\s*"([^"]+)"/gm)].map(([, path]) => path!.replace(/\*$/, ''));
      expect(new Set(entries)).toEqual(new Set(WORKER_PREFIXES));
    }
  });
});

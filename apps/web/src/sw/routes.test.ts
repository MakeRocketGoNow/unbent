import { describe, expect, it } from 'vitest';
import { classify, servesShell, type RequestFacts } from './routes.js';

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
  it.each([
    '/api/notes',
    '/api/notes?notebook=Coupons&tag=a&sort=title&cursor=abc',
    '/api/notes?trashed=1&limit=1',
    '/api/notes/8f0c2d1e',
    '/api/notes/8f0c2d1e/files',
    '/api/tags',
    '/api/notebooks',
    '/api/notebooks/nb1/fields',
    '/api/notebooks/nb1/fields?counts=1',
    '/api/config',
  ])('keeps the last copy of %s', (path) => {
    expect(classify(facts(path))).toBe('api');
  });

  it.each([
    // Under an allowlisted prefix, but not a read the views are drawn from.
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

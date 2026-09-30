import { describe, expect, it } from 'vitest';
import { servesShell } from './routes.js';

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

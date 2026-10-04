import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INSTANCE_COLOURS, serveManifest } from './manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '../../../web/public');
const source = readFileSync(resolve(publicDir, 'manifest.webmanifest'), 'utf8');

/** The `ASSETS` binding, answering the manifest from the web app's own file. */
const assets = {
  fetch: async (input: Request | string) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    return url.pathname === '/manifest.webmanifest'
      ? new Response(source, { headers: { 'Content-Type': 'application/manifest+json', ETag: '"static"' } })
      : new Response('Not found', { status: 404 });
  },
} as unknown as Fetcher;

interface Manifest {
  name: string;
  short_name: string;
  id: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; purpose?: string }[];
  file_handlers: unknown;
}

const read = async (response: Response) => (await response.json()) as Manifest;

const request = () =>
  new Request('https://pr-222.example.workers.dev/manifest.webmanifest', { headers: { 'If-None-Match': '"static"' } });

describe('serveManifest', () => {
  it('hands production the static file untouched', async () => {
    const response = await serveManifest(request(), { ASSETS: assets });
    expect(await response.text()).toBe(source);
  });

  it('names a preview by its label, first, and draws it in the preview colour', async () => {
    const response = await serveManifest(request(), { ASSETS: assets, INSTANCE_LABEL: 'PR 222', INSTANCE_KIND: 'preview' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/manifest+json');
    // Not the static file's: a 304 against it would keep an older label's manifest.
    expect(response.headers.get('ETag')).toBeNull();
    const manifest = await read(response);
    expect(manifest.name).toBe('PR 222 · Unbent');
    expect(manifest.short_name).toBe('PR 222 · Unbent');
    expect(manifest.icons.map((icon) => icon.src)).toEqual([
      '/icons/preview/icon-192.png',
      '/icons/preview/icon-512.png',
      '/icons/preview/icon-512.png',
    ]);
    // Everything else is the static file's: the file handlers are what a scanner uses.
    const original = JSON.parse(source);
    expect(manifest.file_handlers).toEqual(original.file_handlers);
    expect(manifest.id).toBe(original.id);
    expect(manifest.icons[2]?.purpose).toBe('maskable');
    // The splash is the preview's; the bar above the page under review is not.
    expect(manifest.background_color).toBe('#7b5cd6');
    expect(manifest.theme_color).toBe(original.theme_color);
  });

  it('renames a label with no known kind and keeps its icons', async () => {
    const manifest = await read(await serveManifest(request(), { ASSETS: assets, INSTANCE_LABEL: 'Staging' }));
    expect(manifest.name).toBe('Staging · Unbent');
    expect(manifest.icons).toEqual(JSON.parse(source).icons);
    expect(manifest.background_color).toBe(JSON.parse(source).background_color);
  });

  it('colours each kind as the page does', () => {
    const styles = readFileSync(resolve(here, '../../../web/src/styles.css'), 'utf8');
    for (const [kind, colour] of Object.entries(INSTANCE_COLOURS)) {
      expect(styles).toMatch(new RegExp(`--instance-${kind}:\\s*${colour};`, 'i'));
    }
  });

  it('points only at icons that exist, for every kind', async () => {
    for (const kind of ['dev', 'preview', 'local']) {
      const manifest = await read(
        await serveManifest(request(), { ASSETS: assets, INSTANCE_LABEL: kind, INSTANCE_KIND: kind }),
      );
      for (const { src } of manifest.icons) expect(() => readFileSync(resolve(publicDir, `.${src}`))).not.toThrow();
      expect(() => readFileSync(resolve(publicDir, `icons/${kind}/apple-touch-icon.png`))).not.toThrow();
    }
  });
});

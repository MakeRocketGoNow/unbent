import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPERATOR_PLACEHOLDER } from '@unbent/shared';
import { PAGES, render } from './prerender.js';

/**
 * The Worker's tables of prerendered files (`PRERENDERED` and `FRONT_FILE` in
 * `apps/api/src/lib/front-pages.ts`), read from its source. Imported, the module would
 * bring the Worker's auth and Hono into the web suite, which has neither; the toml tests
 * read their lists the same way.
 */
function workerTables(): { prerendered: Record<string, string>; frontFile: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, '../../api/src/lib/front-pages.ts'), 'utf8');
  const constant = (name: string) => source.match(new RegExp(`export const ${name} = '([^']+)'`))?.[1];
  const table = source.match(/export const PRERENDERED[^=]*= \{([\s\S]*?)\n\};/)?.[1];
  if (!table) throw new Error('PRERENDERED not found in front-pages.ts');
  const prerendered: Record<string, string> = {};
  for (const [, quoted, named, file] of table.matchAll(/^\s*(?:'([^']+)'|\[(\w+)\]):\s*'([^']+)',?$/gm)) {
    const path = quoted ?? constant(named!);
    if (!path) throw new Error(`${named} not found in front-pages.ts`);
    prerendered[path] = file!;
  }
  return { prerendered, frontFile: constant('FRONT_FILE') ?? '' };
}

describe('PAGES', () => {
  /*
   * The Worker hands each page's file over by its own table, kept in step with this one
   * by hand. A page missing there is served the shell; a file named differently is a 404
   * from the asset layer. `/` is the Worker's `FRONT_FILE` rather than a row of its table,
   * since a signed-in load of `/` must be the shell.
   */
  it('names the same pages and files as the Worker’s tables', () => {
    const { prerendered, frontFile } = workerTables();
    expect(Object.keys(prerendered).length).toBeGreaterThan(0);
    const files = Object.entries(PAGES)
      .filter(([path]) => path !== '/')
      .map(([path, { file }]) => [path, `/${file}`]);
    expect(Object.fromEntries(files)).toEqual(prerendered);
    expect(`/${PAGES['/']!.file}`).toBe(frontFile);
  });
});

describe('render', () => {
  /*
   * The Worker's `fillOperator` hands back a copy with no placeholder in it unchanged, and
   * its tests feed it hand-written HTML, so they prove only its half. If `SupportPage`
   * stopped drawing the operator from the config (the address obfuscated, moved, or put
   * behind another flag), the copy would lose its lead sentence, the app would write it
   * back in on load, and nothing would fail. This is the build's half.
   */
  it('writes the operator placeholders into support’s copy', async () => {
    const html = await render('/support');
    expect(html).toContain(`mailto:${OPERATOR_PLACEHOLDER.email}`);
    expect(html).toContain(OPERATOR_PLACEHOLDER.name);
  });
});

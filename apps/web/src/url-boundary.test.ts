import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The boundary that keeps navigation the router's business.
 *
 * This test outlived the module it was written for. It used to confine URL and history
 * APIs to `use-url-state.ts`; that module is gone, replaced by TanStack Router, and the
 * same rule now guards against reaching around the router with raw history calls. An
 * abstraction like this erodes silently once it is bypassed once — and it was the reason
 * the router migration touched so few files.
 *
 * `notes-api.ts` is allowed because its `URLSearchParams` builds an outbound API query
 * string, which has nothing to do with browser navigation; the pattern cannot tell the
 * two apart. The embed note route is allowed because it decodes the router's own
 * `location.searchStr` — read through `useLocation`, so the router still owns the
 * location — to keep the Android app's colour values as the strings they were written
 * as; the router's parsed search had turned an all-digit colour into a number. Reading a
 * string is not navigating either.
 */
describe('url boundary', () => {
  it('leaves navigation to the router', () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)));

    let out = '';
    try {
      out = execFileSync(
        'grep',
        [
          '-rn',
          '-E',
          'URLSearchParams|history\\.(push|replace)State|location\\.search',
          '--include=*.ts',
          '--include=*.tsx',
          '--exclude=routeTree.gen.ts',
          src,
        ],
        { encoding: 'utf8' },
      );
    } catch {
      // grep exits 1 when nothing matches.
      out = '';
    }

    const allowed = ['notes-api.ts', 'embed.notes.$noteId.tsx', 'url-boundary.test.ts'];
    const offenders = out
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        const file = line.slice(0, line.indexOf(':'));
        return !allowed.some((name) => file.endsWith(name));
      });

    expect(offenders).toEqual([]);
  });
});

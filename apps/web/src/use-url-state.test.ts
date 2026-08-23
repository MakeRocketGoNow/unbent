import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextUrl, parse, subscribeForTest, type UrlState, writeUrl } from './use-url-state.js';

/**
 * These exercise the pure codec (`parse` / `nextUrl`) plus the store's behaviour driven
 * through jsdom's real history API. The React binding is a thin `useSyncExternalStore`
 * wrapper over that store, so testing the store covers the logic that can actually be
 * wrong — no React renderer needed.
 */

describe('parse', () => {
  it('reads every param it owns', () => {
    const s = parse('?notebook=Medical%20History&tag=Doctor%20Visit&note=abc123&q=phar');

    expect(s).toEqual({
      notebook: 'Appliance Manuals',
      tag: 'Doctor Visit',
      note: 'abc123',
      q: 'phar',
    });
  });

  it('reports missing params as null, and a missing query as empty string', () => {
    const s = parse('');

    expect(s.notebook).toBeNull();
    expect(s.tag).toBeNull();
    expect(s.note).toBeNull();
    // '' rather than null: the search box is a controlled input, and null would make
    // React flip it to uncontrolled.
    expect(s.q).toBe('');
  });

  it('treats an empty param as absent', () => {
    const s = parse('?tag=&note=');

    expect(s.tag).toBeNull();
    expect(s.note).toBeNull();
  });

  it('ignores params it does not own', () => {
    expect(parse('?import=1&tag=x').tag).toBe('x');
  });
});

describe('nextUrl', () => {
  it('omits cleared values instead of leaving empty params', () => {
    const url = nextUrl({ notebook: null, tag: 'urgent' }, '/', '?notebook=Work&tag=urgent');

    // The whole point: no `?notebook=&tag=urgent`.
    expect(url).toBe('/?tag=urgent');
  });

  it('leaves a bare path when every param is cleared', () => {
    const url = nextUrl(
      { notebook: null, tag: null, note: null, q: '' },
      '/',
      '?notebook=Work&tag=urgent&note=abc&q=hi',
    );

    expect(url).toBe('/');
  });

  it('merges a patch rather than replacing the whole state', () => {
    const url = nextUrl({ tag: 'urgent' }, '/', '?notebook=Work&note=abc');
    const s = parse(url.slice(url.indexOf('?')));

    expect(s.notebook).toBe('Work');
    expect(s.note).toBe('abc');
    expect(s.tag).toBe('urgent');
  });

  it('preserves params it does not own', () => {
    const url = nextUrl({ tag: 'new' }, '/', '?import=1&tag=old');

    expect(new URLSearchParams(url.slice(url.indexOf('?'))).get('import')).toBe('1');
  });

  it('leaves keys absent from the patch untouched', () => {
    const url = nextUrl({ q: 'hi' }, '/', '?tag=keepme');

    expect(parse(url.slice(url.indexOf('?'))).tag).toBe('keepme');
  });
});

describe('round-tripping values that need encoding', () => {
  const cases: Array<[string, Partial<UrlState>, keyof UrlState, string]> = [
    ['a space', { notebook: 'Appliance Manuals' }, 'notebook', 'Appliance Manuals'],
    ['an ampersand', { tag: 'R&D' }, 'tag', 'R&D'],
    ['a hash', { q: 'issue #42' }, 'q', 'issue #42'],
    ['an equals sign', { q: 'a=b' }, 'q', 'a=b'],
    ['a plus sign', { q: 'c++' }, 'q', 'c++'],
    ['a percent sign', { q: '100%' }, 'q', '100%'],
    ['non-ascii', { notebook: 'Café ☕' }, 'notebook', 'Café ☕'],
    ['a slash', { tag: 'a/b' }, 'tag', 'a/b'],
  ];

  for (const [label, patch, key, expected] of cases) {
    it(`round-trips ${label}`, () => {
      const url = nextUrl(patch, '/', '');
      expect(parse(url.slice(url.indexOf('?')))[key]).toBe(expected);
    });
  }
});

/**
 * The real write path, driven against jsdom's history.
 *
 * These call `writeUrl` — the exact function the hook's `set` is bound to. An earlier
 * version of this file reimplemented the push/replace logic inside the test; breaking the
 * shipped code left all tests green, which is the failure mode this avoids.
 */
describe('history granularity', () => {
  beforeEach(() => window.history.replaceState(null, '', '/'));
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('pushes an entry by default', () => {
    const before = window.history.length;

    writeUrl({ note: 'abc123' });

    expect(window.history.length).toBe(before + 1);
    expect(parse(window.location.search).note).toBe('abc123');
  });

  it('does not push when replace is set', () => {
    const before = window.history.length;

    // Search-as-you-type: one entry per character would make Back useless.
    writeUrl({ q: 'p' }, { replace: true });
    writeUrl({ q: 'ph' }, { replace: true });
    writeUrl({ q: 'phar' }, { replace: true });

    expect(window.history.length).toBe(before);
    expect(parse(window.location.search).q).toBe('phar');
  });

  it('does not push when the write changes nothing', () => {
    window.history.replaceState(null, '', '/?tag=urgent');
    const before = window.history.length;

    writeUrl({ tag: 'urgent' });

    // Otherwise Back appears stuck after repeated identical selections.
    expect(window.history.length).toBe(before);
  });

  it('clears a param from the live URL', () => {
    window.history.replaceState(null, '', '/?tag=urgent&note=abc');

    writeUrl({ tag: null });

    expect(window.location.search).toBe('?note=abc');
  });
});

describe('subscriber notification', () => {
  beforeEach(() => window.history.replaceState(null, '', '/'));
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('notifies on its own writes', () => {
    let calls = 0;
    const unsubscribe = subscribeForTest(() => {
      calls += 1;
    });

    // pushState does not fire popstate, so without an explicit emit the UI would not
    // react to its own navigation.
    writeUrl({ note: 'abc123' });

    expect(calls).toBe(1);
    unsubscribe();
  });

  it('notifies on popstate', () => {
    let calls = 0;
    const unsubscribe = subscribeForTest(() => {
      calls += 1;
    });

    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(calls).toBe(1);
    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    let calls = 0;
    subscribeForTest(() => {
      calls += 1;
    })();

    writeUrl({ note: 'abc123' });

    expect(calls).toBe(0);
  });
});

/**
 * The boundary that keeps a future router migration a one-file change.
 *
 * Without this, `URLSearchParams` gradually reappears in components and the abstraction
 * stops being one — quietly, and noticed only when the migration is attempted.
 */
describe('module boundary', () => {
  it('confines URL and history APIs to this module', () => {
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
          src,
        ],
        { encoding: 'utf8' },
      );
    } catch {
      // grep exits 1 when nothing matches.
      out = '';
    }

    const allowed = ['use-url-state.ts', 'use-url-state.test.ts', 'notes-api.ts', 'App.tsx'];
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

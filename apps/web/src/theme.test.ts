import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_KEY, readChoice, resolveTheme, setThemeChoice } from './theme.js';

/** jsdom has no `matchMedia`; this one answers the dark query as the test says. */
let deviceDark = false;
let onDeviceChange: (() => void) | null = null;
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: query === '(prefers-color-scheme: dark)' && deviceDark,
  addEventListener: (_: string, listener: () => void) => {
    onDeviceChange = listener;
  },
  removeEventListener: () => {},
}));

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    deviceDark = false;
    delete document.documentElement.dataset.theme;
  });
  afterEach(() => localStorage.clear());

  it('follows the device until something is chosen', () => {
    expect(readChoice()).toBe('auto');
    expect(resolveTheme('auto')).toBe('light');
    deviceDark = true;
    expect(resolveTheme('auto')).toBe('dark');
  });

  it('holds a chosen theme against the device', () => {
    deviceDark = true;
    setThemeChoice('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  /** Auto is the absence of a choice, so going back to it leaves nothing behind. */
  it('stores Auto as no key at all', () => {
    setThemeChoice('dark');
    setThemeChoice('auto');
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('reads anything it does not know as Auto', () => {
    localStorage.setItem(THEME_KEY, '"dark"');
    expect(readChoice()).toBe('auto');
  });

  it('follows the device as it changes while Auto is chosen', async () => {
    const { installTheme } = await import('./theme.js');
    installTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
    deviceDark = true;
    onDeviceChange?.();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  /**
   * `index.html` draws the first frame before any module runs, so it has its own copy of
   * the rule. This runs that copy against the same cases, so the two cannot drift.
   */
  it('agrees with the inline script in index.html', () => {
    const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.html'), 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toContain(`'${THEME_KEY}'`);
    for (const stored of [null, 'light', 'dark', 'nonsense']) {
      for (const dark of [false, true]) {
        deviceDark = dark;
        if (stored === null) localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, stored);
        delete document.documentElement.dataset.theme;
        new Function(script!)();
        expect(document.documentElement.dataset.theme, `${stored} on a ${dark ? 'dark' : 'light'} device`).toBe(
          resolveTheme(readChoice()),
        );
      }
    }
  });

  /**
   * Every dark rule keys off `[data-theme='dark']`. One written the old way, under the
   * media query, would follow the device past the person's choice and fail nowhere else.
   */
  it('keeps the stylesheet free of colour-scheme media queries', () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
    expect(css).not.toMatch(/@media[^{]*prefers-color-scheme/);
  });
});

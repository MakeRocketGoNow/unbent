import { useSyncExternalStore } from 'react';

/**
 * Light, dark, or whatever the device says: the person's choice, kept on this device.
 *
 * The stylesheet draws its dark theme under `:root[data-theme='dark']`, never under a
 * `prefers-color-scheme` query, so that one attribute on `<html>` is the whole switch and
 * each theme is written once. The attribute always carries the theme in effect, never
 * "auto": with Auto chosen it is the device's answer, kept current here as the device
 * changes. Following the device stays the default, so a person who never opens Settings
 * gets what they had before this existed.
 *
 * The attribute is first written by the inline script in `index.html`, before the
 * stylesheet paints anything, because a module script runs after the first frame and a
 * dark-mode reader would get a white flash on every load. That script reads the same key
 * with the same rules as `readChoice` below; change one and change the other.
 *
 * Three answers rather than the two-state toggle a header switch should be. The
 * argument for two (a toggle that only offers the opposite of the device's theme) is
 * about a control that is always on screen, where a third state is noise between the
 * visitor and the page. This one lives on a settings page, read on purpose, and there
 * "back to following my device" has to be a thing you can choose: with two states, a
 * person who picked Dark on a dark device could never again tell the app to follow the
 * device into light.
 *
 * Per device, not per account: it is what the screen is like (a desk lamp, a phone at
 * night), and the device's own setting is per device too.
 */
export type ThemeChoice = 'auto' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

/**
 * The localStorage key, under `usePersistentState`'s prefix but a bare word rather than
 * JSON, so the inline script in `index.html` reads it without parsing anything.
 */
export const THEME_KEY = 'unbent.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The stored choice, or Auto for anything missing, unreadable or unknown. */
export function readChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'auto';
  } catch {
    // Storage can be disabled entirely; the device's own setting is the safe answer.
    return 'auto';
  }
}

function deviceTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}

/** The theme a choice draws, on this device now. */
export function resolveTheme(choice: ThemeChoice): Theme {
  return choice === 'auto' ? deviceTheme() : choice;
}

const listeners = new Set<() => void>();

function apply(): void {
  document.documentElement.dataset.theme = resolveTheme(currentChoice());
  for (const listener of listeners) listener();
}

/**
 * Keeps `<html data-theme>` true to the choice and the device from here on: the device
 * switching while Auto is chosen, and the choice changing in another tab of this app
 * (a `storage` event, which a tab never hears for its own writes). Called once, at start.
 */
export function installTheme(): void {
  apply();
  window.matchMedia?.(DARK_QUERY).addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_KEY || event.key === null) apply();
  });
}

/** Stores a choice and draws it at once. Auto is stored as no key at all, the default. */
export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
    fallback = null;
  } catch {
    // Private browsing or a full quota: the choice still applies until the page goes.
    fallback = choice;
  }
  apply();
}

/** A choice storage refused to keep, held for this page so the control still answers. */
let fallback: ThemeChoice | null = null;

function currentChoice(): ThemeChoice {
  return fallback ?? readChoice();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The person's choice, for the control that sets it. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, currentChoice, () => 'auto');
}

/** The theme in effect, for what script has to pick by theme (a video's file, say). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => resolveTheme(currentChoice()), () => 'light');
}

/**
 * The `media` for a `<picture>`'s dark `<source>`, so a picture follows the choice and
 * not only the device. With Auto chosen it is the device's own query, which the browser
 * follows by itself; a chosen theme pins it on (`all`) or off (`not all`). A prerendered
 * page has no choice to read, so its copy says the device's query too.
 */
export function useDarkSourceMedia(): string {
  return useSyncExternalStore(
    subscribe,
    () => {
      const choice = currentChoice();
      if (choice === 'auto') return DARK_QUERY;
      return choice === 'dark' ? 'all' : 'not all';
    },
    () => DARK_QUERY,
  );
}

/** Calls `listener` whenever the theme in effect may have changed. For the app bridge. */
export function onThemeChange(listener: () => void): () => void {
  return subscribe(listener);
}

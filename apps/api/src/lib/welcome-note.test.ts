import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WELCOME_BODY, WELCOME_TITLE } from './welcome-note.js';

/** Every `[text](target)` in the body, as its target. */
function linkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)].map((m) => m[1]!);
}

/**
 * The web app's route files, read from the tree rather than pinned in a list here, so a
 * page that is renamed or removed fails this test instead of leaving a dead link in every
 * account made after it. The routes are TanStack's flat files: `/settings/import` is
 * `settings.import.tsx`.
 */
const ROUTES = join(import.meta.dirname, '..', '..', '..', 'web', 'src', 'routes');
const routeFileFor = (path: string) => join(ROUTES, `${path.slice(1).replaceAll('/', '.')}.tsx`);

describe('the welcome note', () => {
  it('has a title and a body', () => {
    expect(WELCOME_TITLE).toBe('Welcome to Unbent');
    expect(WELCOME_BODY.trim().length).toBeGreaterThan(0);
  });

  /*
   * Every instance writes this note, self-hosted ones included, so it must not send their
   * people to unbent.app or quote them a price that is not theirs to charge.
   */
  it('names no host and no price', () => {
    const text = `${WELCOME_TITLE}\n${WELCOME_BODY}`;
    expect(text).not.toMatch(/unbent\.app/i);
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/www\./i);
    expect(text).not.toMatch(/[$€£¥]/);
    expect(text).not.toMatch(/\b(price|per (month|year)|a (month|year)|trial)\b/i);
  });

  it('links only to paths on this site', () => {
    const targets = linkTargets(WELCOME_BODY);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      // Root-relative and nothing else: not `//host`, not a scheme, not `files/…`.
      expect(target).toMatch(/^\/(?!\/)[a-z0-9/-]*$/);
    }
  });

  it('links only to pages the web app has', () => {
    for (const target of linkTargets(WELCOME_BODY)) {
      expect(existsSync(routeFileFor(target)), `no route file for ${target}`).toBe(true);
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen.js';
import { openSitePath } from './useHostApp.js';
import { WELCOME_BODY, WELCOME_TITLE } from './welcome-note.js';

/** Every `[text](target)` in the body, as its target. */
function linkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)].map((m) => m[1]!);
}

describe('the sample note', () => {
  it('has a title and a body', () => {
    expect(WELCOME_TITLE).toBe('Welcome to Unbent');
    expect(WELCOME_BODY.trim().length).toBeGreaterThan(0);
  });

  /*
   * Every instance offers this note, self-hosted ones included, so it must not send their
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

  /**
   * Against the app's real route tree, through the rule a click on the link takes
   * (`openSitePath`): a page that is renamed or removed fails here, rather than every note
   * made after it carrying a link that does nothing when clicked.
   */
  it('links only to pages the app has', () => {
    // Matching never runs a route's code, so the context is only there to satisfy the type.
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/'] }),
      context: { queryClient: new QueryClient() },
    });
    const site = { navigate: vi.fn(), getMatchedRoutes: router.getMatchedRoutes.bind(router) };
    for (const target of linkTargets(WELCOME_BODY)) {
      expect(openSitePath(site, target), target).toBe(true);
    }
  });
});

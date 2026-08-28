import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';

/**
 * The tag list's open-by-default behaviour.
 *
 * `<details open>` is an attribute, not a style, so no media query can close it — the
 * breakpoint has to reach it through JS. That makes this the one part of the tag
 * disclosure worth a test: everything else about it is CSS, which jsdom does not evaluate.
 *
 * The markup is reproduced rather than rendering NotesLayout, which would need the router,
 * a query client and three API endpoints to reach one attribute. If that markup moves,
 * this test is a reminder to keep the default keyed to the breakpoint — not a claim about
 * the sidebar's structure.
 */
function TagDisclosure({ activeTag }: { activeTag?: string }) {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  return (
    <details data-testid="tags" key={String(isMobile)} open={!isMobile}>
      <summary>
        Tags
        {activeTag && <span className="tag-filter-active">{activeTag}</span>}
      </summary>
      <div className="tag-filter">
        <button type="button">Medical</button>
      </div>
    </details>
  );
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('tag disclosure', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is open where the sidebar has room for it', () => {
    stubMatchMedia(false);
    render(<TagDisclosure />);
    expect(screen.getByTestId('tags')).toHaveProperty('open', true);
  });

  it('is closed on a phone, where the list filled the screen', () => {
    stubMatchMedia(true);
    render(<TagDisclosure />);
    expect(screen.getByTestId('tags')).toHaveProperty('open', false);
  });

  /**
   * A filter that is applied but invisible is the failure this guards: collapsed, the
   * summary is the only thing saying the list is scoped to a tag.
   */
  it('shows the active tag on the summary while collapsed', () => {
    stubMatchMedia(true);
    render(<TagDisclosure activeTag="Dentist Visit" />);
    const details = screen.getByTestId('tags');
    expect(details).toHaveProperty('open', false);
    expect(details.querySelector('summary')?.textContent).toContain('Dentist Visit');
  });
});

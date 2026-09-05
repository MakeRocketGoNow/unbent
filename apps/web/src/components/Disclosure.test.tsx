import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { Disclosure } from './Disclosure.js';

/**
 * The open-default contract.
 *
 * Everything else about a disclosure is CSS — the chevron, the truncation, the touch target —
 * and jsdom evaluates none of it. What is left is the one thing written in JS, and it is the
 * one thing that is easy to get quietly wrong: `open` is a DOM attribute the user can change
 * by clicking, so a new default only takes if the element is remounted. That remount is the
 * behaviour these tests pin.
 *
 * The `.not.toBe(before)` assertions are deliberate and are not testing an implementation
 * detail. A different host node *is* the mechanism — there is no other way to re-apply a
 * default to an element the user has already toggled — and asserting on `open` alone cannot
 * see it, because at every crossing the value the user toggled to happens to equal the next
 * breakpoint's default.
 */
function stubMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return (next: boolean) => {
    matches = next;
    listeners.forEach((fn) => fn());
  };
}

const details = (c: HTMLElement) => c.querySelector('details') as HTMLDetailsElement;

describe('Disclosure', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens a "wide" disclosure where there is room for it', () => {
    stubMatchMedia(false);
    const { container } = render(<Disclosure summary="Tags">body</Disclosure>);
    expect(details(container)).toHaveProperty('open', false);

    cleanup();
    const wide = render(
      <Disclosure summary="Tags" defaultOpen="wide">
        body
      </Disclosure>,
    );
    expect(details(wide.container)).toHaveProperty('open', true);
  });

  it('closes a "wide" disclosure on a phone, where it filled the screen', () => {
    stubMatchMedia(true);
    const { container } = render(
      <Disclosure summary="Tags" defaultOpen="wide">
        body
      </Disclosure>,
    );
    expect(details(container)).toHaveProperty('open', false);
  });

  /** The contract that could not be expressed before this component existed. */
  it('leaves a "never" disclosure closed at both widths', () => {
    const setMatches = stubMatchMedia(false);
    const { container } = render(<Disclosure summary="Attachments (4)">body</Disclosure>);
    expect(details(container)).toHaveProperty('open', false);

    act(() => setMatches(true));
    expect(details(container)).toHaveProperty('open', false);
  });

  it('re-applies the "wide" default when the viewport crosses the breakpoint', () => {
    const setMatches = stubMatchMedia(false);
    const { container } = render(
      <Disclosure summary="Tags" defaultOpen="wide">
        body
      </Disclosure>,
    );

    const before = details(container);
    // What a click does, and it happens outside React's knowledge.
    before.open = false;

    act(() => setMatches(true));

    expect(details(container)).not.toBe(before);
    expect(details(container)).toHaveProperty('open', false);
  });

  /**
   * The no-key half of the design, and the half a later refactor is likeliest to undo:
   * keying every disclosure would look tidier and would close an attachments panel out from
   * under someone every time they rotated the phone.
   */
  it('does not disturb a "never" disclosure the user has opened', () => {
    const setMatches = stubMatchMedia(true);
    const { container } = render(<Disclosure summary="Attachments (4)">body</Disclosure>);

    const before = details(container);
    before.open = true;

    act(() => setMatches(false));

    expect(details(container)).toBe(before);
    expect(details(container)).toHaveProperty('open', true);
  });

  /**
   * A filter that is applied but invisible was the original failure here: collapsed, the
   * summary is the only thing saying the list is scoped to a tag.
   */
  it('states its value on the summary while collapsed', () => {
    stubMatchMedia(true);
    const { container } = render(
      <Disclosure summary={<>Tags<span>Dentist Visit</span></>} defaultOpen="wide">
        body
      </Disclosure>,
    );

    const el = details(container);
    expect(el).toHaveProperty('open', false);
    expect(el.querySelector('summary')?.textContent).toContain('Dentist Visit');
  });
});

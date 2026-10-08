import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ParsedLocation } from '@tanstack/react-router';
import {
  goBackToList,
  isListPath,
  isNotePath,
  noteTransitionTypes,
  onBackArrowClick,
  recordBehind,
  slideFor,
  trackWhatIsBehind,
  watchHistoryMoves,
} from './note-nav.js';

/** As much of a router location as the decision reads. */
function at(pathname: string, index = 0, key = `k${index}`): ParsedLocation {
  return { pathname, state: { __TSR_index: index, __TSR_key: key } } as unknown as ParsedLocation;
}

function phone(on: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: on, media: query }));
}

/** A history move the page did not make, arriving at the entry `key`. */
function popTo(key: string, opts: { drawn?: boolean } = {}) {
  const e = new PopStateEvent('popstate', { state: { __TSR_key: key } });
  if (opts.drawn) Object.defineProperty(e, 'hasUAVisualTransition', { value: true });
  window.dispatchEvent(e);
}

beforeAll(() => watchHistoryMoves());

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.UnbentApp;
});

describe('the paths', () => {
  it('tells a list from a note, in the notes view and the trash', () => {
    expect(isListPath('/notes')).toBe(true);
    expect(isListPath('/trash/')).toBe(true);
    expect(isNotePath('/notes/n1')).toBe(true);
    expect(isNotePath('/trash/n1')).toBe(true);
    expect(isListPath('/notes/n1')).toBe(false);
    expect(isNotePath('/notes')).toBe(false);
    expect(isNotePath('/settings/notebooks')).toBe(false);
    expect(isNotePath('/embed/notes/n1')).toBe(false);
  });
});

describe('slideFor', () => {
  it('slides in going from a list to a note, and back coming out, whichever way the history went', () => {
    expect(slideFor('/notes', '/notes/n1', false)).toBe('note-open');
    expect(slideFor('/notes', '/notes/n1', true)).toBe('note-open');
    expect(slideFor('/notes/n1', '/notes', false)).toBe('note-close');
    expect(slideFor('/trash/n1', '/trash', true)).toBe('note-close');
  });

  it('follows the history from one note to another', () => {
    expect(slideFor('/notes/n1', '/notes/n2', false)).toBe('note-open');
    expect(slideFor('/notes/n2', '/notes/n1', true)).toBe('note-close');
  });

  it('does not slide for a list redrawn with other filters, the same note, or anywhere else', () => {
    expect(slideFor('/notes', '/notes', false)).toBeNull();
    expect(slideFor('/notes/n1', '/notes/n1', true)).toBeNull();
    expect(slideFor('/notes', '/settings', false)).toBeNull();
    expect(slideFor('/settings/notebooks', '/notes/n1', false)).toBeNull();
  });
});

describe('noteTransitionTypes', () => {
  it('names the slide on a phone and nothing on a desktop', () => {
    phone(true);
    expect(noteTransitionTypes({ fromLocation: at('/notes', 1), toLocation: at('/notes/n1', 2) })).toEqual(['note-open']);
    expect(noteTransitionTypes({ fromLocation: at('/notes/n1', 2), toLocation: at('/notes', 1) })).toEqual(['note-close']);
    phone(false);
    expect(noteTransitionTypes({ fromLocation: at('/notes', 1), toLocation: at('/notes/n1', 2) })).toBe(false);
  });

  it('draws nothing for the first page, which has nowhere to slide from', () => {
    phone(true);
    expect(noteTransitionTypes({ toLocation: at('/notes/n1') })).toBe(false);
  });

  it('skips a move the browser has already drawn, and only that one', () => {
    phone(true);
    popTo('k1', { drawn: true });
    expect(noteTransitionTypes({ fromLocation: at('/notes/n1', 2), toLocation: at('/notes', 1) })).toBe(false);
    // The flag answered for that move; the next one slides as usual.
    expect(noteTransitionTypes({ fromLocation: at('/notes', 1), toLocation: at('/notes/n1', 2) })).toEqual(['note-open']);
  });

  it('ignores a drawn move that arrived somewhere else', () => {
    phone(true);
    popTo('elsewhere', { drawn: true });
    expect(noteTransitionTypes({ fromLocation: at('/notes/n1', 2), toLocation: at('/notes', 1) })).toEqual(['note-close']);
  });

  it('slides for a move the browser left undrawn, as Android Back is', () => {
    phone(true);
    popTo('k1');
    expect(noteTransitionTypes({ fromLocation: at('/notes/n1', 2), toLocation: at('/notes', 1) })).toEqual(['note-close']);
  });

  it('takes every history move in the iOS app as the edge swipe, which has drawn itself', () => {
    phone(true);
    window.UnbentApp = { platform: 'ios' } as typeof window.UnbentApp;
    popTo('k1');
    expect(noteTransitionTypes({ fromLocation: at('/notes/n1', 2), toLocation: at('/notes', 1) })).toBe(false);
  });
});

describe('recordBehind', () => {
  it('puts the page a step forward left behind the page it arrived at', () => {
    const behind = new Map<string, string>();
    recordBehind(behind, at('/notes', 3, 'list'), at('/notes/n1', 4, 'note'));
    expect(behind.get('note')).toBe('/notes');
  });

  it('keeps what was behind a page that is replaced, as a new note replaces /notes?new=1', () => {
    const behind = new Map([['new', '/notes']]);
    recordBehind(behind, at('/notes', 4, 'new'), at('/notes/n1', 4, 'note'));
    expect(behind.get('note')).toBe('/notes');
  });

  it('writes nothing for a walk back through the history, or for the first page', () => {
    const behind = new Map([['note', '/notes']]);
    recordBehind(behind, at('/notes/n1', 4, 'note'), at('/notes', 3, 'list'));
    recordBehind(behind, undefined, at('/notes', 0, 'first'));
    expect([...behind]).toEqual([['note', '/notes']]);
  });
});

describe('the back arrow', () => {
  /**
   * A router with only what the tracker and the arrow use: navigations reported as they
   * resolve, the current entry, and a way back that records being asked.
   */
  function track() {
    let report: ((e: { fromLocation?: ParsedLocation; toLocation: ParsedLocation }) => void) | undefined;
    sessionStorage.clear();
    const router = {
      subscribe: (_type: 'onResolved', fn: NonNullable<typeof report>) => {
        report = fn;
      },
      history: { location: { state: {} as unknown }, back: vi.fn() },
    };
    trackWhatIsBehind(router);
    const go = (from: ParsedLocation, to: ParsedLocation) => {
      report?.({ fromLocation: from, toLocation: to });
      router.history.location = { state: to.state };
    };
    return { router, go, back: router.history.back };
  }

  it('goes back through the history when the list is the page behind the note', () => {
    const { router, go, back } = track();
    go(at('/notes', 0, 'list'), at('/notes/n1', 1, 'note'));
    expect(goBackToList(router, '/notes')).toBe(true);
    expect(back).toHaveBeenCalledOnce();
  });

  it('leaves the link to replace the note when something else is behind it', () => {
    const { router, go, back } = track();
    go(at('/notes/n1', 1, 'one'), at('/notes/n2', 2, 'two'));
    expect(goBackToList(router, '/notes')).toBe(false);
    expect(goBackToList(router, '/trash')).toBe(false);
    expect(back).not.toHaveBeenCalled();
  });

  it('leaves a modified click to the link, to open the list in a new tab', () => {
    const { router, go, back } = track();
    go(at('/notes', 0, 'list'), at('/notes/n1', 1, 'note'));
    const preventDefault = vi.fn();
    const click = { button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, preventDefault };
    onBackArrowClick(router, '/notes')(click);
    expect(back).not.toHaveBeenCalled();
    onBackArrowClick(router, '/notes')({ ...click, metaKey: false });
    expect(back).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('slides its walk back in the iOS app, where a walk the page did not start would not', () => {
    phone(true);
    window.UnbentApp = { platform: 'ios' } as typeof window.UnbentApp;
    const { router, go } = track();
    go(at('/notes', 0, 'list'), at('/notes/n1', 1, 'note'));
    goBackToList(router, '/notes');
    popTo('list');
    expect(noteTransitionTypes({ fromLocation: at('/notes/n1', 1, 'note'), toLocation: at('/notes', 0, 'list') })).toEqual([
      'note-close',
    ]);
  });
});
